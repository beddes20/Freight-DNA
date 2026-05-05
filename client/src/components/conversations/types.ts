export interface ConversationThread {
  id: string;
  orgId: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  accountName?: string | null;
  carrierName?: string | null;
  waitingState: "waiting_on_us" | "waiting_on_them" | "resolved" | "archived" | "snoozed";
  responsePriority: "high" | "normal" | "low" | "urgent";
  lastMessageId: string | null;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  // Phase 1 — "Stop lying about freshness."
  // Source-of-truth email-activity timestamp. Computed server-side as
  // MAX(email_messages.provider_sent_at) per thread, with a defensive
  // fallback to GREATEST(lastIncomingAt, lastOutgoingAt). The Conversations
  // list MUST read this (or lastIncomingAt / lastOutgoingAt) for every
  // user-facing freshness label — never `updatedAt`, which is bumped by
  // background workers and is routinely days off the actual email activity.
  lastEmailAt: string | null;
  waitingSinceAt: string | null;
  overdueAt: string | null;
  archivedAt: string | null;
  snoozedUntil?: string | null;
  snoozedFromState?: string | null;
  snoozedByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  signals?: string[];
  lastReadAt?: string | null;
  unread?: boolean;
  // ─── Free-mail attribution recovery (Task #1056 / Email→Exec 5) ──────────
  // Informational stamp recording HOW this thread came to be linked (or
  // suggested-linked) to its `linkedAccountId`. Drives the
  // <AttributionBadge> next to <WaitingStateBadge>. Always nullable —
  // legacy threads from before Task #1056 carry NULL.
  attributionInferenceSource?:
    | "contact"
    | "domain"
    | "thread"
    | "signature"
    | "weak"
    // Confirmed variants — set by the confirm-attribution route when a
    // rep one-click-confirms a Tier-2/3 inference. Preserves the
    // original tier so the audit trail isn't laundered into 'contact'.
    | "confirmed_signature"
    | "confirmed_weak"
    | null;
  attributionEvidence?: {
    label?: string;
    matchedText?: string;
    suggestedCompanyName?: string;
    senderEmail?: string;
    senderDisplayName?: string;
  } | null;
}

export interface ThreadsResponse {
  count: number;
  threads: ConversationThread[];
  nextCursor: string | null;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  direction: string;
  fromEmail: string | null;
  toEmail: string | null;
  ccEmail: string | null;
  subject: string | null;
  body: string | null;
  createdAt: string;
  providerSentAt: string | null;
}

export type ConversationBucket =
  | "mine"
  | "unowned"
  | "quote_requests"
  | "high_priority"
  | "all"
  | "snoozed"
  | "archived";

const VALID_BUCKETS: ReadonlySet<ConversationBucket> = new Set([
  "mine",
  "unowned",
  "quote_requests",
  "high_priority",
  "all",
  "snoozed",
  "archived",
]);

// ─── Saved Views (Task #533) ─────────────────────────────────────────────────
export interface SavedViewFilters {
  filterState?: string;
  filterPriority?: string;
  filterOverdue?: boolean;
  filterRep?: string;
}

export interface SavedView {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  bucket: ConversationBucket;
  filters: SavedViewFilters;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BulkActionResult {
  action: string;
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; error?: string }>;
}

// Coerce a raw URL param into a known bucket. Anything outside the whitelist
// (typo, stale link, hand-rolled URL) falls back to "mine" so downstream code
// — including the empty-state map lookup keyed by bucket — can't blow up.
export function parseBucket(raw: string | null | undefined): ConversationBucket {
  return raw && VALID_BUCKETS.has(raw as ConversationBucket)
    ? (raw as ConversationBucket)
    : "mine";
}

export type ConversationDensity = "comfortable" | "compact";

// ─── Grouping (Task #535) ────────────────────────────────────────────────────
// "None" preserves the existing flat list. "Account" groups by linked account
// (companies); "Carrier" groups by linked carrier. Threads with no link land
// under an "Unlinked" group at the bottom.
export type ConversationGroupBy = "none" | "account" | "carrier";

export interface ConversationGroup {
  // Stable key for React + selection: account/carrier id, or the literal
  // "__unlinked__" sentinel for threads with no link.
  key: string;
  // Display name shown in the header.
  name: string;
  threads: ConversationThread[];
  openCount: number;
  highestPriority: ConversationThread["responsePriority"];
  oldestWaitingAt: string | null;
  unreadCount: number;
}

export const UNLINKED_GROUP_KEY = "__unlinked__";

const PRIORITY_RANK: Record<ConversationThread["responsePriority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// "Open" = anything still in the rep's queue (waiting_on_us / waiting_on_them).
// Resolved / archived / snoozed don't add to the open count on the header.
function isOpen(thread: ConversationThread): boolean {
  return thread.waitingState === "waiting_on_us" || thread.waitingState === "waiting_on_them";
}

// Build groups from a pre-sorted thread list. Sort order *within* each group is
// preserved from the input — the page already sorts by overdue / wait age /
// recency, and grouping doesn't second-guess that. Group order: anything with
// a real account/carrier first, sorted by name; then the Unlinked bucket.
export function buildGroups(
  threads: ConversationThread[],
  groupBy: ConversationGroupBy,
): ConversationGroup[] {
  if (groupBy === "none") return [];
  const map = new Map<string, ConversationGroup>();

  for (const t of threads) {
    let key: string;
    let name: string;
    if (groupBy === "account") {
      key = t.linkedAccountId ?? UNLINKED_GROUP_KEY;
      name = t.linkedAccountId ? (t.accountName ?? "Account") : "Unlinked";
    } else {
      key = t.linkedCarrierId ?? UNLINKED_GROUP_KEY;
      name = t.linkedCarrierId ? (t.carrierName ?? "Carrier") : "Unlinked";
    }

    let group = map.get(key);
    if (!group) {
      group = {
        key,
        name,
        threads: [],
        openCount: 0,
        highestPriority: "low",
        oldestWaitingAt: null,
        unreadCount: 0,
      };
      map.set(key, group);
    }
    group.threads.push(t);
    if (isOpen(t)) group.openCount++;
    if (t.unread) group.unreadCount++;
    if (PRIORITY_RANK[t.responsePriority] < PRIORITY_RANK[group.highestPriority]) {
      group.highestPriority = t.responsePriority;
    }
    if (t.waitingSinceAt && t.waitingState === "waiting_on_us") {
      if (!group.oldestWaitingAt || new Date(t.waitingSinceAt) < new Date(group.oldestWaitingAt)) {
        group.oldestWaitingAt = t.waitingSinceAt;
      }
    }
  }

  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    const aUnlinked = a.key === UNLINKED_GROUP_KEY;
    const bUnlinked = b.key === UNLINKED_GROUP_KEY;
    if (aUnlinked !== bUnlinked) return aUnlinked ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return groups;
}

export const QUOTE_SIGNAL_TYPES = new Set(["pricing_request", "quote_request"]);

export function hasQuoteSignal(thread: ConversationThread): boolean {
  return (thread.signals ?? []).some(s => QUOTE_SIGNAL_TYPES.has(s));
}

// Task #968 — viewer-aware bucket-label resolver. Maps the
// (waitingState, ownerUserId) tuple to the label the rep sees in the
// sidebar + URL. Pure, exported so unit tests can pin the contract.
export type BucketLabel =
  | { key: "mine"; label: "Mine"; bucket: "mine" }
  | { key: "unowned"; label: "Unowned"; bucket: "unowned" }
  | { key: "owned"; label: "Owned"; bucket: "all" }
  | { key: "awaiting_customer"; label: "Awaiting customer"; bucket: "all" }
  | { key: "resolved"; label: "Resolved"; bucket: "all" }
  | { key: "archived"; label: "Archived"; bucket: "archived" }
  | { key: "snoozed"; label: "Snoozed"; bucket: "snoozed" }
  | { key: "all"; label: "All"; bucket: "all" };

export function resolveBucketLabel(
  waitingState: string | null | undefined,
  ownerUserId: string | null | undefined,
  viewerUserId: string | null | undefined,
): BucketLabel {
  switch (waitingState) {
    case "waiting_on_us":
      if (ownerUserId && viewerUserId && ownerUserId === viewerUserId) {
        return { key: "mine", label: "Mine", bucket: "mine" };
      }
      if (ownerUserId) return { key: "owned", label: "Owned", bucket: "all" };
      return { key: "unowned", label: "Unowned", bucket: "unowned" };
    case "waiting_on_them":
      return { key: "awaiting_customer", label: "Awaiting customer", bucket: "all" };
    case "resolved":
      return { key: "resolved", label: "Resolved", bucket: "all" };
    case "archived":
      return { key: "archived", label: "Archived", bucket: "archived" };
    case "snoozed":
      return { key: "snoozed", label: "Snoozed", bucket: "snoozed" };
    default:
      return { key: "all", label: "All", bucket: "all" };
  }
}
