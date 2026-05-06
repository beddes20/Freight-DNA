// Task #957 — Queue bucket registry for the Available Freight cockpit.
//
// A "bucket" is a named slice of the visible queue surfaced as a chip in
// the cockpit toolstrip ("Ready to send", "Pickup today", "At risk <24h",
// etc). Buckets are derived from the SAME filtered collection that drives
// the KPI strip, the rows, and the ROI panel so the count on a chip is
// always exactly the number of rows the rep would see if they clicked it.
//
// Lives in `shared/` so the server can compute counts off the same row
// shape the client filter sees, and so unit tests can drive the predicate
// directly without a React render.

import {
  isPickupToday,
  isPickupWithinHours,
  isPickupOnCalendarDayOffset,
  ACTIONABLE_OPEN_STATUSES,
} from "./pickupFreshness";

export const BUCKET_KEYS = [
  "all",
  "ready_to_send",
  "pickup_today",
  "pickup_tomorrow",
  "at_risk_24h",
  "team_needs_approval",
  "no_response_4h",
  "covered_today",
  "unassigned",
  "stale",
] as const;

export type BucketKey = typeof BUCKET_KEYS[number];

export interface BucketDefinition {
  key: BucketKey;
  label: string;
  // One-line description used as a tooltip/aria-label.
  description: string;
  // Visual tone consumed by the chip strip; matches the existing tones in
  // available-freight.tsx (info / ready / warn / critical / ok / muted).
  tone: "info" | "ready" | "warn" | "critical" | "ok" | "muted";
}

export const BUCKETS: Record<BucketKey, BucketDefinition> = {
  all: {
    key: "all",
    label: "All",
    description: "Every row currently visible after URL + saved-view filters.",
    tone: "muted",
  },
  ready_to_send: {
    key: "ready_to_send",
    label: "Ready to send",
    description: "Approved rows whose top carriers haven't been emailed yet.",
    tone: "ready",
  },
  pickup_today: {
    key: "pickup_today",
    label: "Pickup today",
    description: "Pickup window starts today (org local).",
    tone: "warn",
  },
  pickup_tomorrow: {
    key: "pickup_tomorrow",
    label: "Pickup tomorrow",
    description: "Pickup window starts tomorrow (org local).",
    tone: "info",
  },
  at_risk_24h: {
    key: "at_risk_24h",
    label: "At risk <24h",
    description: "Pickup within 24h AND no carrier has confirmed yet.",
    tone: "critical",
  },
  team_needs_approval: {
    key: "team_needs_approval",
    label: "Team needs approval",
    description: "Pending approval — your direct reports' loads waiting on you.",
    tone: "warn",
  },
  no_response_4h: {
    key: "no_response_4h",
    label: "No response 4h",
    description: "Sent ≥4h ago with zero carrier replies.",
    tone: "warn",
  },
  covered_today: {
    key: "covered_today",
    label: "Covered today",
    description: "Loads marked covered today.",
    tone: "ok",
  },
  unassigned: {
    key: "unassigned",
    label: "Unassigned",
    description: "Rows with no owner or delegated dispatcher.",
    tone: "info",
  },
  stale: {
    key: "stale",
    label: "Stale",
    description: "Past pickup but still in an actionable status (>24h overdue).",
    tone: "muted",
  },
};

export const BUCKET_ORDER: BucketKey[] = [
  "all",
  "ready_to_send",
  "pickup_today",
  "pickup_tomorrow",
  "at_risk_24h",
  "team_needs_approval",
  "no_response_4h",
  "covered_today",
  "unassigned",
  "stale",
];

// Task #1023 — Per-mode bucket ordering.
//
// All three Available Freight modes operate on the SAME underlying
// row collection (so a count of N on a chip means the same N rows in
// every mode). What differs is which buckets are surfaced first and
// which become noise. Action leads with triage chips ("Ready to send",
// "At risk <24h"); Coverage leads with the outreach funnel ("No
// response 4h", "Covered today"); Ops leads with the health-and-leak
// chips ("Stale", "Unassigned"). The "All" chip always anchors the
// strip so the rep can clear the bucket filter without thinking.
//
// The set of bucket keys is intentionally a SUBSET / re-ordering of
// `BUCKET_ORDER` — never a new bucket — so the existing scope rules
// and counts apply unchanged across modes.
export type AvailableFreightModeId = "action" | "coverage" | "ops";

export const BUCKET_ORDER_BY_MODE: Record<AvailableFreightModeId, BucketKey[]> = {
  action: [
    "all",
    "ready_to_send",
    "at_risk_24h",
    "pickup_today",
    "pickup_tomorrow",
    "team_needs_approval",
    "covered_today",
  ],
  coverage: [
    "all",
    "no_response_4h",
    "at_risk_24h",
    "pickup_today",
    "pickup_tomorrow",
    "covered_today",
  ],
  ops: [
    "all",
    "stale",
    "unassigned",
    "team_needs_approval",
    "covered_today",
  ],
};

export function bucketOrderForMode(mode: AvailableFreightModeId): BucketKey[] {
  return BUCKET_ORDER_BY_MODE[mode] ?? BUCKET_ORDER;
}

// Minimum row shape the bucket predicate needs. Keep this loose so the
// server's pre-`buildCockpitRow` shape and the client's enriched
// `CockpitItem` both satisfy it.
export interface BucketEvalRow {
  opportunity: {
    status?: string | null;
    pickupWindowStart?: string | null;
    coveredAt?: string | null;
    // Task #957 follow-up — `generatedAt` powers the `generatedToday` KPI
    // in `kpisFromFiltered`. Optional so legacy callers (and the bucket-
    // only predicate) compile unchanged.
    generatedAt?: string | Date | null;
  };
  coverage?: {
    sent?: number;
    responded?: number;
    covered?: boolean;
    stage?: string | null;
  } | null;
  freshnessMinutes?: number | null;
  ownership?: { ids?: readonly string[] | null; emails?: readonly string[] | null } | null;
  owner?: { id?: string | null } | null;
  pickupFreshness?: "no_pickup" | "upcoming" | "past_recent" | "past_stale" | null;
  pickupDaysAgo?: number | null;
  // For team_needs_approval: the bucket caller passes a Set of "team
  // member" user ids (resolved via cockpitTeams). Per-row attribution is
  // checked against the row's ownership envelope.
}

export interface BucketEvalContext {
  todayIso: string;
  // Optional set of user ids considered "my team" — used by
  // team_needs_approval. When omitted the bucket only matches rows the
  // current user owns themselves.
  myTeamUserIds?: ReadonlySet<string> | null;
  currentUserId?: string | null;
}

function ownershipIdSet(row: BucketEvalRow): Set<string> {
  const ids = new Set<string>();
  const env = row.ownership ?? null;
  if (env && Array.isArray(env.ids)) {
    for (const id of env.ids) if (id) ids.add(id);
  }
  if (row.owner?.id) ids.add(row.owner.id);
  return ids;
}

function isUnassigned(row: BucketEvalRow): boolean {
  return ownershipIdSet(row).size === 0;
}

function isPastStale(row: BucketEvalRow): boolean {
  // A row is "stale" for bucketing purposes when its pickup is past the
  // 24h soft-overdue window AND the status is still actionable. We honour
  // the server-stamped pickupFreshness when present (so the chip can't
  // disagree with the badge in the row), and fall back to the days
  // counter for legacy payloads.
  const status = row.opportunity?.status ?? null;
  if (!status || !ACTIONABLE_OPEN_STATUSES.has(status)) return false;
  if (row.pickupFreshness === "past_stale") return true;
  if (typeof row.pickupDaysAgo === "number" && row.pickupDaysAgo > 1) return true;
  return false;
}

function isCoveredToday(row: BucketEvalRow, todayIso: string): boolean {
  const ca = row.opportunity?.coveredAt;
  if (typeof ca === "string" && ca.length >= 10) {
    return ca.slice(0, 10) === todayIso;
  }
  // Fall back to coverage flag — the older payload doesn't carry coveredAt.
  return !!row.coverage?.covered;
}

// Returns the set of bucket keys this row belongs to. "all" is always
// present so the bucket-strip "All" chip is consistent with row counts.
export function bucketsForRow(
  row: BucketEvalRow,
  ctx: BucketEvalContext,
): Set<BucketKey> {
  const out = new Set<BucketKey>();
  out.add("all");
  const status = row.opportunity?.status ?? null;
  const pickup = row.opportunity?.pickupWindowStart ?? null;
  const sent = row.coverage?.sent ?? 0;
  const responded = row.coverage?.responded ?? 0;
  const freshness = row.freshnessMinutes ?? null;

  if (status === "ready_to_send") out.add("ready_to_send");
  // Task #1019 — `pickup_today` and `pickup_tomorrow` are calendar-day
  // buckets anchored in org-local time. Both go through the same
  // `isPickupOnCalendarDayOffset` helper so they are mutually exclusive
  // by construction and never drift with the time-of-day the way the
  // older `isPickupAfterHours(24) && isPickupWithinHours(48)` combo did.
  if (isPickupOnCalendarDayOffset(pickup, ctx.todayIso, 0)) {
    out.add("pickup_today");
  }
  if (isPickupOnCalendarDayOffset(pickup, ctx.todayIso, 1)) {
    out.add("pickup_tomorrow");
  }
  if (
    isPickupWithinHours(pickup, 24, ctx.todayIso) &&
    !row.coverage?.covered
  ) {
    out.add("at_risk_24h");
  }
  if (status === "pending_approval") {
    // "Team needs approval" — restricted to direct reports + me when an
    // explicit team set was provided. Otherwise everyone in pending
    // approval qualifies (manager-less view).
    if (ctx.myTeamUserIds && ctx.myTeamUserIds.size > 0) {
      const ids = ownershipIdSet(row);
      let matched = false;
      for (const uid of ctx.myTeamUserIds) {
        if (ids.has(uid)) {
          matched = true;
          break;
        }
      }
      if (matched) out.add("team_needs_approval");
    } else {
      out.add("team_needs_approval");
    }
  }
  if (sent > 0 && responded === 0 && freshness !== null && freshness >= 240) {
    out.add("no_response_4h");
  }
  if (isCoveredToday(row, ctx.todayIso)) out.add("covered_today");
  if (isUnassigned(row)) out.add("unassigned");
  if (isPastStale(row)) out.add("stale");
  return out;
}

export function rowMatchesBucket(
  row: BucketEvalRow,
  bucket: BucketKey,
  ctx: BucketEvalContext,
): boolean {
  if (bucket === "all") return true;
  return bucketsForRow(row, ctx).has(bucket);
}

// Count rows per bucket in a single pass. The chip strip uses this to
// avoid running the predicate N×M times.
export type BucketCounts = Record<BucketKey, number>;

export function emptyBucketCounts(): BucketCounts {
  const out = {} as BucketCounts;
  for (const k of BUCKET_KEYS) out[k] = 0;
  return out;
}

export function countBuckets(
  rows: readonly BucketEvalRow[],
  ctx: BucketEvalContext,
): BucketCounts {
  const counts = emptyBucketCounts();
  for (const row of rows) {
    const keys = bucketsForRow(row, ctx);
    for (const k of keys) counts[k]++;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────
// Task #957 follow-up — KPI strip derived from the SAME filtered collection
// that drives the visible rows + bucket chip strip + hidden-state
// diagnostics.
//
// Before this change the cockpit's KPI tiles came from the server's
// `feed.kpis` payload, which only respected the server-side filters
// (snooze + pickupScope + lane + carrier + ownerFilter). Client-side
// search / status / bucket selections did not narrow the KPIs, so a rep
// who typed a search saw the row list shrink while the tiles stayed
// constant — a confusing "this can't be the same dataset" mismatch.
//
// `kpisFromFiltered` is the single shared helper. Every count uses the
// same predicate as `bucketsForRow`, so chip counts and KPI tiles can
// never disagree:
//   - `total`               → rows.length (matches the "All" chip)
//   - `readyToSend`         → bucket "ready_to_send"
//   - `atRiskPickup24h`     → bucket "at_risk_24h"
//   - `coveredToday`        → bucket "covered_today"
//   - `sentAwaitingCarrier` → coverage.sent > 0 AND coverage.responded === 0
//   - `generatedToday`      → opportunity.generatedAt's date == ctx.todayIso
//   - `avgFreshnessMinutes` → mean of row.freshnessMinutes (null when none)
//
// `hiddenStale` is intentionally NOT computed here — it counts past-pickup
// rows the actionable rule has hidden from the FEED, which is a server-
// only signal. The cockpit page merges it on top of the result.
export interface KpisFromFiltered {
  total: number;
  generatedToday: number;
  readyToSend: number;
  sentAwaitingCarrier: number;
  atRiskPickup24h: number;
  coveredToday: number;
  avgFreshnessMinutes: number | null;
}

function generatedAtDayKey(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  if (value.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function kpisFromFiltered(
  rows: readonly BucketEvalRow[],
  ctx: BucketEvalContext,
): KpisFromFiltered {
  let total = 0;
  let generatedToday = 0;
  let readyToSend = 0;
  let sentAwaitingCarrier = 0;
  let atRiskPickup24h = 0;
  let coveredToday = 0;
  let freshnessSum = 0;
  let freshnessCount = 0;
  for (const row of rows) {
    total++;
    const buckets = bucketsForRow(row, ctx);
    if (buckets.has("ready_to_send")) readyToSend++;
    if (buckets.has("at_risk_24h")) atRiskPickup24h++;
    if (buckets.has("covered_today")) coveredToday++;
    const sent = row.coverage?.sent ?? 0;
    const responded = row.coverage?.responded ?? 0;
    if (sent > 0 && responded === 0) sentAwaitingCarrier++;
    const genKey = generatedAtDayKey(row.opportunity?.generatedAt ?? null);
    if (genKey !== null && genKey === ctx.todayIso) generatedToday++;
    const fr = row.freshnessMinutes ?? null;
    if (typeof fr === "number" && Number.isFinite(fr)) {
      freshnessSum += fr;
      freshnessCount++;
    }
  }
  return {
    total,
    generatedToday,
    readyToSend,
    sentAwaitingCarrier,
    atRiskPickup24h,
    coveredToday,
    avgFreshnessMinutes: freshnessCount === 0 ? null : Math.round(freshnessSum / freshnessCount),
  };
}
