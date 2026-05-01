// Task #635 — Reciprocal cross-link chips between AF cockpit and LWQ.
//
// Two render modes share one component so the visual treatment, hover,
// and deep-link behavior stay in sync between surfaces.
//
// Cross-tab UX (option F) — every chip is wrapped in a Tooltip that
// previews its top context fields on hover, so a rep can decide whether
// the navigation is worth it without paying the click+route cost. The
// data shown comes entirely from props the chip already receives — no
// extra fetch.

import { Link } from "wouter";
import { Inbox, Truck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { appendCrossTabFromParam } from "./cross-tab-breadcrumb";

export interface LwqContextChipData {
  laneId: string;
  contactedCount: number;
  lastTouchAt: string | null;
  replyCount: number;
  hotReplyCount: number;
  /**
   * Task #871 — propagated from the LWQ scoring engine so AF rows can
   * render the same Stable/Volatile/Hot badge LWQ shows. `null` when the
   * lane has not been scored (treated as "Spot" by the badge).
   */
  stability?: "stable" | "volatile" | "hot" | null;
}

export interface LiveOppsChipData {
  laneSignature: string;
  count: number;
  totalLoads: number;
  /** Combined customer-side revenue across the lane's open opps today. */
  combinedRevenue?: number;
  nextPickupAt: string | null;
}

/**
 * Format a dollar amount as a compact "$14K" / "$1.2M" string. Returns null
 * when the value rounds to less than $500 so the chip stays clean for noisy
 * pre-cover loads with no revenue stamped yet.
 */
function formatCombinedRevenue(usd: number | undefined): string | null {
  if (!usd || !Number.isFinite(usd) || usd < 500) return null;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}

function relativeAge(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatPickup(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Chip rendered on AF cockpit rows that link back to the LWQ lane. */
export function LwqContextChip({
  data,
  testId,
}: {
  data: LwqContextChipData;
  testId?: string;
}) {
  const age = relativeAge(data.lastTouchAt);
  const parts: string[] = [];
  if (age) parts.push(`last touched ${age}`);
  parts.push(`${data.contactedCount} carrier${data.contactedCount === 1 ? "" : "s"} contacted`);
  if (data.replyCount > 0) {
    parts.push(`${data.replyCount} repl${data.replyCount === 1 ? "y" : "ies"}`);
  }
  const link = (
    <Link
      href={appendCrossTabFromParam(
        `/lanes/work-queue?laneId=${encodeURIComponent(data.laneId)}`,
        "available-freight",
        typeof window !== "undefined" ? window.location.search : "",
      )}
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[10px] py-0.5 px-2 rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400 hover:border-blue-500 hover:bg-blue-500/20 transition-colors"
      data-testid={testId ?? "chip-lwq-context"}
    >
      <Inbox className="w-3 h-3 shrink-0" />
      <span className="truncate">In your LWQ — {parts.join(" · ")}</span>
    </Link>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-xs"
          data-testid={`${testId ?? "chip-lwq-context"}-hover`}
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-foreground">In your Lane Work Queue</div>
            <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>Carriers contacted</span>
              <span className="text-foreground" data-testid="hover-lwq-contacted">
                {data.contactedCount}
              </span>
              <span>Replies</span>
              <span className="text-foreground" data-testid="hover-lwq-replies">
                {data.replyCount}
                {data.hotReplyCount > 0 ? ` (${data.hotReplyCount} hot)` : ""}
              </span>
              <span>Last touch</span>
              <span className="text-foreground" data-testid="hover-lwq-last-touch">
                {age ?? "—"}
              </span>
            </div>
            <div className="pt-1 text-[10px] text-muted-foreground">Click to open in LWQ</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Chip rendered on LWQ rows that link to AF filtered to this lane. */
export function LiveOppsChip({
  data,
  testId,
}: {
  data: LiveOppsChipData;
  testId?: string;
}) {
  const pickup = formatPickup(data.nextPickupAt);
  const revenue = formatCombinedRevenue(data.combinedRevenue);
  const parts: string[] = [`${data.count} live opp${data.count === 1 ? "" : "s"} today`];
  if (revenue) parts.push(`${revenue} combined`);
  if (data.totalLoads !== data.count) parts.push(`${data.totalLoads} loads`);
  if (pickup) parts.push(`pickup ${pickup}`);
  const link = (
    <Link
      href={appendCrossTabFromParam(
        `/available-freight?lane=${encodeURIComponent(data.laneSignature)}`,
        "lane-work-queue",
        typeof window !== "undefined" ? window.location.search : "",
      )}
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[10px] py-0.5 px-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:border-emerald-500 hover:bg-emerald-500/20 transition-colors"
      data-testid={testId ?? "chip-live-opps"}
    >
      <Truck className="w-3 h-3 shrink-0" />
      <span className="truncate">{parts.join(" · ")}</span>
    </Link>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-xs"
          data-testid={`${testId ?? "chip-live-opps"}-hover`}
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-foreground">Live in Available Freight</div>
            <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>Open opps</span>
              <span className="text-foreground" data-testid="hover-af-count">
                {data.count}
              </span>
              <span>Total loads</span>
              <span className="text-foreground" data-testid="hover-af-totalloads">
                {data.totalLoads}
              </span>
              <span>Combined revenue</span>
              <span className="text-foreground" data-testid="hover-af-revenue">
                {revenue ?? "—"}
              </span>
              <span>Next pickup</span>
              <span className="text-foreground" data-testid="hover-af-pickup">
                {pickup ?? "—"}
              </span>
            </div>
            <div className="pt-1 text-[10px] text-muted-foreground">Click to open in Available Freight</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
