// Task #871 — Lane Cockpit overlay (dual-pane sheet).
//
// Reachable from AF, LWQ, Today, and the Switchboard via the shared
// keyboard's `L` key, the row overflow menu, or the cross-link chips.
// Renders BOTH faces of a lane:
//   • Recurring / LWQ (history, contactable bench, last touch, replies)
//   • Live / AF       (open opportunities today, customer tier, pickups)
// from a SINGLE backend round-trip keyed by lane signature.
//
// The sheet itself owns no business state — it only renders what
// `/api/lanes/cockpit` returns. Cross-link chips inside the sheet still
// route the rep to the underlying surface for deep work.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Truck, Inbox, ExternalLink, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FreshnessPill, type FreshnessSignal } from "@/components/freight/freshness-pill";
import { LaneStabilityBadge, type LaneStability } from "@/components/freight/lane-stability-badge";

export interface LaneCockpitRecurringRow {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyName: string | null;
  ownerName: string | null;
  laneScore: number | null;
  carriersContactedCount: number;
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
  avgLoadsPerWeek: string | null;
  weeksActive: number | null;
  lookbackWeeks: number | null;
  isHighFrequency: boolean;
  isManual: boolean;
  noContactable: boolean;
  lastTouchAt: string | null;
  replyCount: number;
  hotReplyCount: number;
  weeklyLoadHistory: number[];
}

export interface LaneCockpitLiveRow {
  opportunityId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  status: string;
  pickupWindowStart: string | null;
  loadCount: number | null;
  generatedAt: string | null;
  ageMinutes: number | null;
  customerName: string | null;
  customerTier: string | null;
}

export interface LaneCockpitHeader {
  signature: string;
  customerTier: string | null;
  stability: LaneStability | null;
  freshness: FreshnessSignal;
}

export interface LaneCockpitResponse {
  signature: string;
  recurring: LaneCockpitRecurringRow | null;
  live: LaneCockpitLiveRow[];
  headerSignals: LaneCockpitHeader;
}

function fmtLane(o: string, os: string | null, d: string, ds: string | null) {
  return `${o}${os ? `, ${os}` : ""} → ${d}${ds ? `, ${ds}` : ""}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtPickup(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface LaneCockpitSheetProps {
  /** Canonical signature: `origin|originState|destination|destinationState|equipmentType` (lower-case). */
  signature: string | null;
  /** Surface that opened the cockpit — used to set the cross-link chip default. */
  openedFrom: "af" | "lwq" | "today" | "switchboard";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-formatted lane label from the calling row. Avoids a second “loading…” for the title. */
  laneLabel?: string;
}

export function LaneCockpitSheet({
  signature,
  openedFrom,
  open,
  onOpenChange,
  laneLabel,
}: LaneCockpitSheetProps) {
  const query = useQuery<LaneCockpitResponse>({
    queryKey: ["/api/lanes/cockpit", { signature }],
    enabled: open && !!signature,
    // The default queryFn joins the queryKey with "/" — with an object segment
    // that produces "/api/lanes/cockpit/[object Object]" which 404s. Build the
    // URL explicitly so both panes actually receive data.
    queryFn: async () => {
      const res = await fetch(
        `/api/lanes/cockpit?signature=${encodeURIComponent(signature ?? "")}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`cockpit fetch failed: ${res.status}`);
      return (await res.json()) as LaneCockpitResponse;
    },
  });

  const data = query.data;
  const recurring = data?.recurring ?? null;
  const live = data?.live ?? [];
  const header = data?.headerSignals;

  const titleLane = laneLabel
    ?? (recurring
      ? fmtLane(recurring.origin, recurring.originState, recurring.destination, recurring.destinationState)
      : live[0]
        ? fmtLane(live[0].origin, live[0].originState, live[0].destination, live[0].destinationState)
        : "Lane Cockpit");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl overflow-y-auto p-0"
        data-testid="sheet-lane-cockpit"
        data-opened-from={openedFrom}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-border">
          <SheetTitle data-testid="text-cockpit-lane">{titleLane}</SheetTitle>
          <SheetDescription>
            Dual-pane view of recurring history and today’s live opportunities.
          </SheetDescription>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {header?.freshness && (
              <FreshnessPill
                signal={header.freshness}
                testId="pill-cockpit-freshness"
                popoverTestId="popover-cockpit-freshness"
              />
            )}
            <LaneStabilityBadge
              stability={header?.stability ?? null}
              testId="badge-cockpit-stability"
            />
            {header?.customerTier && (
              <Badge variant="outline" className="text-[10px]" data-testid="badge-cockpit-tier">
                {header.customerTier}
              </Badge>
            )}
            {recurring?.isManual && (
              <Badge variant="outline" className="text-[10px] bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30">
                Manual lane
              </Badge>
            )}
            {recurring?.isHighFrequency && (
              <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30">
                High-frequency
              </Badge>
            )}
          </div>
        </SheetHeader>

        {query.isLoading && (
          <div
            className="flex items-center justify-center py-16 text-sm text-muted-foreground"
            data-testid="state-cockpit-loading"
          >
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading lane cockpit…
          </div>
        )}
        {query.isError && (
          <div
            className="px-6 py-10 text-sm text-red-600 dark:text-red-400"
            data-testid="state-cockpit-error"
          >
            Couldn’t load this lane. Try again in a moment.
          </div>
        )}

        {!query.isLoading && !query.isError && data && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-border">
            {/* ── Recurring (LWQ) face ──────────────────────────────── */}
            <section className="p-6 space-y-4" data-testid="pane-cockpit-recurring">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-blue-500" />
                  <h3 className="text-sm font-semibold">Recurring (LWQ)</h3>
                </div>
                {recurring && (
                  <Link
                    href={`/lanes/work-queue?laneId=${encodeURIComponent(recurring.laneId)}&from=cockpit`}
                    className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                    data-testid="link-cockpit-open-lwq"
                  >
                    Open in LWQ <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>
              {!recurring ? (
                <div className="text-sm text-muted-foreground" data-testid="empty-cockpit-recurring">
                  No recurring history for this lane yet.
                </div>
              ) : (
                <dl className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                  <RecurringStat label="Customer" value={recurring.companyName ?? "—"} testId="stat-cockpit-customer" />
                  <RecurringStat label="Owner"    value={recurring.ownerName ?? "Unassigned"} testId="stat-cockpit-owner" />
                  <RecurringStat label="Avg loads / week" value={recurring.avgLoadsPerWeek ?? "—"} testId="stat-cockpit-avg" />
                  <RecurringStat label="Weeks active" value={recurring.weeksActive != null ? `${recurring.weeksActive}/${recurring.lookbackWeeks ?? "—"}` : "—"} testId="stat-cockpit-weeks" />
                  <RecurringStat label="Lane score" value={recurring.laneScore != null ? String(recurring.laneScore) : "—"} testId="stat-cockpit-score" />
                  <RecurringStat label="Bench (contactable)" value={`${recurring.contactableCount} / ${recurring.totalBenchCount}`} testId="stat-cockpit-bench" />
                  <RecurringStat label="Carriers contacted" value={String(recurring.carriersContactedCount)} testId="stat-cockpit-contacted" />
                  <RecurringStat label="Last touch" value={fmtAge(recurring.lastTouchAt)} testId="stat-cockpit-lasttouch" />
                  <RecurringStat
                    label="Replies"
                    value={`${recurring.replyCount}${recurring.hotReplyCount > 0 ? ` (${recurring.hotReplyCount} hot)` : ""}`}
                    testId="stat-cockpit-replies"
                  />
                </dl>
              )}
              {recurring && recurring.weeklyLoadHistory.length > 0 && (
                <div data-testid="chart-cockpit-sparkline">
                  <div className="text-[10px] text-muted-foreground mb-1">Recent weekly load trend</div>
                  <div className="flex items-end gap-1 h-12">
                    {recurring.weeklyLoadHistory.map((v, i) => {
                      const max = Math.max(1, ...recurring.weeklyLoadHistory);
                      const h = Math.max(2, Math.round((v / max) * 100));
                      return (
                        <div
                          key={i}
                          className="flex-1 bg-blue-500/70 rounded-sm"
                          style={{ height: `${h}%` }}
                          title={`week ${recurring.weeklyLoadHistory.length - i} ago: ${v}`}
                          data-testid={`bar-cockpit-week-${i}`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* ── Live (AF) face ────────────────────────────────────── */}
            <section className="p-6 space-y-3" data-testid="pane-cockpit-live">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-emerald-500" />
                  <h3 className="text-sm font-semibold">Live today (AF)</h3>
                </div>
                <Link
                  href={`/available-freight?lane=${encodeURIComponent(data.signature)}&from=cockpit`}
                  className="text-xs text-emerald-600 hover:underline inline-flex items-center gap-1"
                  data-testid="link-cockpit-open-af"
                >
                  Open in AF <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
              {live.length === 0 ? (
                <div className="text-sm text-muted-foreground" data-testid="empty-cockpit-live">
                  No live opportunities for this lane right now.
                </div>
              ) : (
                <ul className="divide-y divide-border" data-testid="list-cockpit-live">
                  {live.map(opp => (
                    <li
                      key={opp.opportunityId}
                      className="py-2 flex items-center justify-between text-sm gap-3"
                      data-testid={`row-cockpit-live-${opp.opportunityId}`}
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/available-freight/${opp.opportunityId}?from=cockpit`}
                          className="font-medium hover:underline truncate inline-block max-w-[18rem]"
                          data-testid={`link-cockpit-live-${opp.opportunityId}`}
                        >
                          {opp.customerName ?? "Customer pending"} · {opp.status.replace(/_/g, " ")}
                        </Link>
                        <div className="text-[11px] text-muted-foreground">
                          pickup {fmtPickup(opp.pickupWindowStart)}
                          {opp.loadCount && opp.loadCount > 1 ? ` · ${opp.loadCount} loads` : ""}
                          {opp.ageMinutes != null ? ` · ${opp.ageMinutes}m old` : ""}
                        </div>
                      </div>
                      {opp.customerTier && (
                        <Badge variant="outline" className="text-[10px]">{opp.customerTier}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="button-cockpit-close"
          >
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RecurringStat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium" data-testid={testId}>{value}</dd>
    </>
  );
}
