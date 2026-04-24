export interface ConversationThread {
  id: string;
  orgId: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingState: "waiting_on_us" | "waiting_on_them" | "resolved" | "archived" | "snoozed";
  responsePriority: "high" | "normal" | "low" | "urgent";
  lastMessageId: string | null;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
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

export const QUOTE_SIGNAL_TYPES = new Set(["pricing_request", "quote_request"]);

export function hasQuoteSignal(thread: ConversationThread): boolean {
  return (thread.signals ?? []).some(s => QUOTE_SIGNAL_TYPES.has(s));
}
