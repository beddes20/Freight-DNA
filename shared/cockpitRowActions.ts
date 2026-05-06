// Task #1022 — Self-explanatory load rows for Available Freight.
//
// Pure helpers that turn a CockpitItem-shaped row into the three pieces of
// metadata the new row layout needs: the "why surfaced" bucket badge, the
// blocking reason, and the next best action.
//
// Keeping this in `shared/` (no React, no DOM) so the resolver is unit-
// testable in isolation and the same priority order can be re-used by
// other surfaces (e.g. tomorrow's Today Queue) without recomputing from
// scratch.

import {
  bucketsForRow,
  type BucketEvalRow,
  type BucketEvalContext,
  type BucketKey,
  type BucketDefinition,
  BUCKETS,
} from "./cockpitBuckets";

// Priority used when a row lands in multiple buckets. Earlier wins.
// Ordered by what most demands the rep's attention RIGHT NOW: a row
// in `at_risk_24h` AND `pickup_tomorrow` should read as "at risk", not
// "pickup tomorrow".
export const WHY_BUCKET_PRIORITY: readonly BucketKey[] = [
  "at_risk_24h",
  "team_needs_approval",
  "no_response_4h",
  "pickup_today",
  "ready_to_send",
  "pickup_tomorrow",
  "stale",
  "unassigned",
  "covered_today",
];

export function pickWhyBucket(
  row: BucketEvalRow,
  ctx: BucketEvalContext,
): BucketDefinition {
  const matched = bucketsForRow(row, ctx);
  for (const k of WHY_BUCKET_PRIORITY) {
    if (matched.has(k)) return BUCKETS[k];
  }
  // Task #1022 — Every row must visibly answer "why surfaced" — there is
  // no row state where the badge is allowed to disappear. When none of
  // the priority buckets match (e.g. a fresh `awaiting_reply` row that's
  // not pickup-soon, not stale, not unassigned), fall back to the "all"
  // bucket definition so the badge always renders with a defensible
  // tone/label instead of silently dropping out.
  return BUCKETS.all;
}

// Tailwind class set for a bucket tone. Mirrors the existing tone palette
// already used by KpiTile / urgency badges so the new "why" badge reads
// consistently with the rest of the cockpit.
export function bucketToneClass(tone: BucketDefinition["tone"]): string {
  switch (tone) {
    case "critical":
      return "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30";
    case "warn":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    case "ready":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30";
    case "info":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30";
    case "ok":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
    case "muted":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

// ──────────────────────────────────────────────────────────────────────
// Blocking reason + next best action.
// ──────────────────────────────────────────────────────────────────────

export type BlockingState =
  | "covered"
  | "pending_approval"
  | "no_carriers"
  | "ready_to_send"
  | "awaiting_reply"
  | "stalled_no_reply"
  | "partial"
  | "import_gap"
  | "none";

export interface BlockingDescriptor {
  state: BlockingState;
  label: string;
}

export type RowActionId =
  | "approve"
  | "send_top"
  | "escalate"
  | "pick_carriers"
  | "mark_covered"
  | "confirm_covered"
  | "open_detail";

export interface RowActionDescriptor {
  id: RowActionId;
  label: string;
  // Optional payload merged into the bulk-action mutation call.
  payload?: Record<string, unknown>;
  // True for actions that route through a confirmation dialog instead of
  // firing the mutation directly. The row hooks "open_detail" and the
  // "mark_covered"/"confirm_covered" cases this way (the cover dialog
  // collects rate inputs); the row component picks them up via this hint.
  needsDialog?: boolean;
  // Non-destructive default action surface (filled, primary). When false
  // the row renders the button as outline so it doesn't shout.
  emphasis: "primary" | "secondary";
  // True when the row is already covered/closed and the button should
  // render disabled. Kept here so the resolver stays the single source of
  // truth for "is this row actionable".
  disabled?: boolean;
}

// Minimum row shape the resolver needs. Mirrors `BucketEvalRow` but with
// a couple of extra carrier/coverage fields so we can decide between
// "send_top" and "pick_carriers".
export interface RowActionInput extends BucketEvalRow {
  coverage?: {
    sent?: number;
    responded?: number;
    covered?: boolean;
    included?: number;
    stage?: string | null;
  } | null;
  /** Number of carriers the cockpit has surfaced as chips. Falls back to
   *  `coverage.included` when omitted. */
  rankedCarrierCount?: number | null;
}

export function resolveBlocking(row: RowActionInput): BlockingDescriptor {
  const status = row.opportunity?.status ?? null;
  const cov = row.coverage ?? null;
  const sent = cov?.sent ?? 0;
  const responded = cov?.responded ?? 0;
  const included = cov?.included ?? 0;
  const ranked = row.rankedCarrierCount ?? included;
  const freshness = row.freshnessMinutes ?? null;

  if (cov?.covered || status === "covered") {
    return { state: "covered", label: "Covered" };
  }
  if (status === "pending_approval") {
    return { state: "pending_approval", label: "Pending approval" };
  }
  // Task #1022 — `import_gap` surfaces when the import landed without
  // enough information for the rep to act: most commonly a missing
  // pickup window (the operator can't pick carriers, can't escalate,
  // can't even snooze meaningfully without one). We treat both an
  // explicit `pickupFreshness === "no_pickup"` and a null pickup
  // start as a gap so legacy rows whose freshness wasn't stamped on
  // import still surface with the right blocking caption.
  const pickupMissing = row.pickupFreshness === "no_pickup"
    || !row.opportunity?.pickupWindowStart;
  if (pickupMissing && ranked === 0 && sent === 0) {
    return {
      state: "import_gap",
      label: "Import gap — pickup time missing",
    };
  }
  if (ranked === 0 && sent === 0) {
    return { state: "no_carriers", label: "No carriers shortlisted" };
  }
  if (sent === 0) {
    return { state: "ready_to_send", label: "Ready to send" };
  }
  if (sent > 0 && responded === 0) {
    if (freshness !== null && freshness >= 240) {
      return { state: "stalled_no_reply", label: "No reply 4h+" };
    }
    return { state: "awaiting_reply", label: "Awaiting carrier reply" };
  }
  if (responded > 0 && !cov?.covered) {
    return { state: "partial", label: "Replies in — pick a carrier" };
  }
  return { state: "none", label: "" };
}

export function resolveNextBestAction(row: RowActionInput): RowActionDescriptor {
  const blocking = resolveBlocking(row);
  switch (blocking.state) {
    case "covered":
      return {
        id: "confirm_covered",
        label: "Confirm covered",
        emphasis: "secondary",
        disabled: true,
      };
    case "pending_approval":
      return { id: "approve", label: "Approve", emphasis: "primary" };
    case "no_carriers":
      return {
        id: "pick_carriers",
        label: "Pick carriers",
        emphasis: "primary",
        needsDialog: true,
      };
    case "ready_to_send":
      return {
        id: "send_top",
        label: "Send to top 3",
        emphasis: "primary",
        payload: { topN: 3 },
      };
    case "awaiting_reply":
      return {
        id: "escalate",
        label: "Send to next 3",
        emphasis: "secondary",
        payload: { topN: 3 },
      };
    case "stalled_no_reply":
      return {
        id: "escalate",
        label: "Escalate — send next 3",
        emphasis: "primary",
        payload: { topN: 3 },
      };
    case "partial":
      return {
        id: "mark_covered",
        label: "Mark covered",
        emphasis: "primary",
        needsDialog: true,
      };
    case "import_gap":
      // The rep can't act on this row until the missing pickup data is
      // patched. Route them to the detail page where the editable
      // opportunity form lives so they can set a pickup window (or hand
      // it off). Stays "primary" so it's the obvious next click.
      return {
        id: "open_detail",
        label: "Set pickup time",
        emphasis: "primary",
        needsDialog: true,
      };
    case "none":
    default:
      return { id: "open_detail", label: "Open", emphasis: "secondary" };
  }
}
