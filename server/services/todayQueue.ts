// Task #639 — Today queue aggregator.
//
// Pulls four work-streams (LWQ touchpoints, Available Freight opps, hot
// reply threads, SLA-breaching customer quotes) into a single normalized
// list, ranks them with a composite priority (customerTier × urgency ×
// time-decay, hot replies floored to the top), filters out anything the
// rep has explicitly snoozed via the "Done for now" action, and returns
// the prioritized page. Designed to fit in a single backend round-trip
// for typical reps (~50 items, <500ms).
//
// The four source-pulls are issued in parallel; each per-source error is
// caught and logged so a flake in (say) the quote service never sinks
// the whole queue.
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import {
  companies,
  emailConversationThreads,
  freightOpportunities,
  todayQueueSnoozes,
  type TodayQueueSource,
} from "@shared/schema";
import { computeCockpitUrgency } from "../routes/freightOpportunityCockpit";
import { getActionQueue } from "./customerQuotes";

export type TodayQueueAction =
  | "send_wave"
  | "reply"
  | "quote_now"
  | "touchpoint";

export interface TodayQueueItem {
  /** Composite identifier "<source>:<sourceId>" — stable + globally unique. */
  id: string;
  source: TodayQueueSource;
  sourceId: string;
  summary: string;
  /** 0–100 normalized urgency from the source surface. */
  urgencyScore: number;
  urgencyLevel: "critical" | "high" | "medium" | "low";
  /** Final composite ranker score — higher = more urgent. Used only for sorting. */
  priorityScore: number;
  /** One-line "why this is here" reason. */
  reason: string;
  primaryActionLabel: string;
  primaryAction: TodayQueueAction;
  deepLink: string;
  customerName: string | null;
  /** Minutes since the underlying surface flagged this item. */
  ageMinutes: number | null;
  /**
   * Set on hot_reply rows when the underlying thread is high-priority.
   * Drives the +1000 ranker floor; normal/low-priority replies do NOT
   * receive the floor and rank on the same scale as the other sources.
   */
  isHotReply?: boolean;
}

export interface TodayQueueResponse {
  items: TodayQueueItem[];
  nextCursor: string | null;
  totalBeforePagination: number;
  generatedAt: string;
  /** Per-source counts for the bar chart in the page header. */
  bySource: Record<TodayQueueSource, number>;
}

// "Hot" replies (the customer is actively waiting on us AND the thread is
// flagged high-priority) float to the top of the queue. We add a fixed
// floor to their composite score so even a "low urgency" hot reply
// outranks a "critical" non-reply item.
//
// Normal- and low-priority reply threads still appear in the queue but
// are ranked normally (no floor) — the reviewer flagged that always
// applying the floor over-floats lukewarm replies above genuinely
// urgent freight ops, which is the wrong default.
const HOT_REPLY_FLOOR = 1000;

// ── Pure ranker (kept out of the SQL path so it can be tested in isolation) ─
//
// composite = customerTier × urgency × time-decay
//   + HOT_REPLY_FLOOR if source === "hot_reply" AND isHotReply === true
//
// Decisions on the constants:
//   - tier multiplier: platinum 1.30, gold 1.15, silver 1.05, bronze 0.95,
//     unknown 1.0 — mirrors deriveCustomerTier() in the cockpit so a
//     rep's mental model is consistent across surfaces.
//   - time decay: linear from 1.0 (just now) → 0.6 (24h+) → 0.4 (72h+).
//     Older work doesn't fall off entirely (a stale lane is still real
//     work) but we want fresh signals to win ties.
export function tierMultiplier(tier: string | null | undefined): number {
  switch ((tier ?? "").toLowerCase()) {
    case "platinum": return 1.30;
    case "gold":     return 1.15;
    case "silver":   return 1.05;
    case "bronze":   return 0.95;
    default:         return 1.0;
  }
}

export function timeDecayMultiplier(ageMinutes: number | null | undefined): number {
  if (ageMinutes === null || ageMinutes === undefined) return 1.0;
  if (ageMinutes <= 60) return 1.0;
  if (ageMinutes <= 24 * 60) return 1.0 - (ageMinutes - 60) * (0.4 / (23 * 60));
  if (ageMinutes <= 72 * 60) return 0.6 - (ageMinutes - 24 * 60) * (0.2 / (48 * 60));
  return 0.4;
}

export interface RankerInput {
  source: TodayQueueSource;
  urgencyScore: number;
  customerTier: string | null;
  ageMinutes: number | null;
  /** True only for hot_reply rows where the thread is high-priority. */
  isHotReply?: boolean;
}

export function rankerScore(input: RankerInput): number {
  const base = input.urgencyScore *
    tierMultiplier(input.customerTier) *
    timeDecayMultiplier(input.ageMinutes);
  return (input.source === "hot_reply" && input.isHotReply === true)
    ? base + HOT_REPLY_FLOOR
    : base;
}

export function rankTodayItems<T extends { source: TodayQueueSource; urgencyScore: number; ageMinutes: number | null; }>(
  items: ReadonlyArray<T & { customerTier?: string | null; isHotReply?: boolean }>,
): Array<T & { priorityScore: number }> {
  return items
    .map(item => ({
      ...item,
      priorityScore: rankerScore({
        source: item.source,
        urgencyScore: item.urgencyScore,
        customerTier: item.customerTier ?? null,
        ageMinutes: item.ageMinutes,
        isHotReply: item.isHotReply,
      }),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}


function deriveCustomerTier(estimatedFreightSpend: string | number | null | undefined): string | null {
  if (estimatedFreightSpend === null || estimatedFreightSpend === undefined || estimatedFreightSpend === "") return null;
  const spend = typeof estimatedFreightSpend === "number"
    ? estimatedFreightSpend
    : Number.parseFloat(String(estimatedFreightSpend));
  if (!Number.isFinite(spend) || spend <= 0) return null;
  if (spend >= 1_000_000) return "platinum";
  if (spend >= 500_000) return "gold";
  if (spend >= 100_000) return "silver";
  return "bronze";
}

function urgencyLevelFromScore(score: number): TodayQueueItem["urgencyLevel"] {
  if (score >= 75) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function ageMinutesSince(ts: Date | string | null | undefined, now: Date): number | null {
  if (!ts) return null;
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts.getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

function fmtLane(o: string, os: string | null, d: string, ds: string | null): string {
  return `${os ? `${o}, ${os.toUpperCase()}` : o} → ${ds ? `${d}, ${ds.toUpperCase()}` : d}`;
}


// ── Per-source pulls. Each returns a normalized array of TodayQueueItem. ────

interface SourceContext {
  orgId: string;
  userId: string;
  now: Date;
}

// LWQ — lanes the rep owns that have hot carrier replies waiting (top
// signal in the LWQ workflow). Cap at 50 to keep the aggregator cheap;
// the rep can deep-link to the full LWQ for the long tail.
async function fetchLwqItems(ctx: SourceContext): Promise<TodayQueueItem[]> {
  try {
    // Today queue is intentionally a "MY queue" view — surface only lanes the
    // current rep owns. Director / cross-team rollups belong on the LWQ page
    // itself, not in this single-user prioritized inbox.
    const cached = await storage.getLaneWorkQueueFromCache(
      ctx.orgId, [ctx.userId], false,
    );
    if (!cached) return [];

    const ownedLanes = [
      ...cached.inProgress,
      ...cached.assignedUntouched,
    ].filter(l => l.ownerUserId === ctx.userId);

    return ownedLanes.slice(0, 50).map(lane => {
      const ageMin = null;
      const urgencyScore = Math.max(0, Math.min(100, lane.laneScore ?? 50));
      const reason = lane.carriersContactedCount > 0
        ? `${lane.carriersContactedCount} carrier${lane.carriersContactedCount === 1 ? "" : "s"} contacted, ${lane.contactableCount} contactable remain`
        : `${lane.contactableCount} contactable carrier${lane.contactableCount === 1 ? "" : "s"} on bench`;
      return {
        id: `lwq:${lane.laneId}`,
        source: "lwq" as const,
        sourceId: lane.laneId,
        summary: `${fmtLane(lane.origin, lane.originState, lane.destination, lane.destinationState)} • ${lane.companyName ?? "—"}`,
        urgencyScore,
        urgencyLevel: urgencyLevelFromScore(urgencyScore),
        priorityScore: 0,
        reason,
        primaryActionLabel: "Send wave",
        primaryAction: "send_wave" as const,
        deepLink: `/lanes/work-queue?laneId=${encodeURIComponent(lane.laneId)}`,
        customerName: lane.companyName,
        ageMinutes: ageMin,
      };
    });
  } catch (err) {
    console.error("[todayQueue] LWQ fetch failed:", err);
    return [];
  }
}

// Available Freight — opps owned (or delegated to) the rep that are still
// active. Reuses computeCockpitUrgency() so the score lines up exactly
// with the Available Freight cockpit page.
async function fetchFreightOppItems(ctx: SourceContext): Promise<TodayQueueItem[]> {
  try {
    const ACTIVE = [
      "new", "ready_to_send", "sent", "awaiting_carrier_reply",
      "awaiting_customer_confirm", "partially_covered", "awaiting_approval",
    ];
    const opps = await db.select().from(freightOpportunities).where(
      and(
        eq(freightOpportunities.orgId, ctx.orgId),
        inArray(freightOpportunities.status, ACTIVE),
        or(
          eq(freightOpportunities.delegatedToUserId, ctx.userId),
          and(
            sql`${freightOpportunities.delegatedToUserId} IS NULL`,
            eq(freightOpportunities.ownerUserId, ctx.userId),
          ),
        ),
        // Hide rows the rep is currently snoozing (snoozedUntil > now).
        // Include rows with no snooze, or whose snooze has already expired.
        or(
          sql`${freightOpportunities.snoozedUntil} IS NULL`,
          sql`${freightOpportunities.snoozedUntil} <= ${ctx.now}`,
        ),
      ),
    ).limit(100);

    if (opps.length === 0) return [];

    const companyIds = Array.from(new Set(opps.map(o => o.companyId)));
    const companyRows = companyIds.length === 0
      ? []
      : await db.select().from(companies).where(inArray(companies.id, companyIds));
    const companyById = new Map(companyRows.map(c => [c.id, c] as const));

    return opps.map(opp => {
      const co = companyById.get(opp.companyId) ?? null;
      const tier = deriveCustomerTier(co?.estimatedFreightSpend ?? null);
      const u = computeCockpitUrgency({
        pickupAt: opp.pickupWindowStart,
        generatedAt: opp.generatedAt,
        includedCarriers: 0,
        sentCarriers: 0,
        respondedCarriers: 0,
        status: opp.status,
        customerTier: tier,
        laneScore: null,
        now: ctx.now,
      });
      const ageMin = ageMinutesSince(opp.generatedAt, ctx.now);
      const reason = u.reasons[0] ?? `pickup ${opp.pickupWindowStart}`;
      return {
        id: `freight_opp:${opp.id}`,
        source: "freight_opp" as const,
        sourceId: opp.id,
        summary: `${fmtLane(opp.origin, opp.originState, opp.destination, opp.destinationState)} • ${co?.name ?? "—"}`,
        urgencyScore: u.score,
        urgencyLevel: u.level,
        priorityScore: 0,
        reason,
        primaryActionLabel: "Send wave",
        primaryAction: "send_wave" as const,
        deepLink: `/available-freight/${opp.id}`,
        customerName: co?.name ?? null,
        ageMinutes: ageMin,
      };
    });
  } catch (err) {
    console.error("[todayQueue] freight-opp fetch failed:", err);
    return [];
  }
}

// Hot replies — threads owned by the rep where the other party is waiting
// on us. High-priority replies always float to the top via HOT_REPLY_FLOOR
// (applied later in the ranker), but normal-priority waiting threads are
// also surfaced — just at a lower score.
async function fetchHotReplyItems(ctx: SourceContext): Promise<TodayQueueItem[]> {
  try {
    const threads = await db.select().from(emailConversationThreads).where(
      and(
        eq(emailConversationThreads.orgId, ctx.orgId),
        eq(emailConversationThreads.ownerUserId, ctx.userId),
        eq(emailConversationThreads.waitingState, "waiting_on_us"),
        // Exclude archived/snoozed — those have their own waiting_state values
        // already, but we add an extra guard against legacy rows.
        sql`${emailConversationThreads.archivedAt} IS NULL`,
      ),
    ).orderBy(desc(emailConversationThreads.lastIncomingAt)).limit(75);

    if (threads.length === 0) return [];

    const accountIds = threads
      .map(t => t.linkedAccountId)
      .filter((v): v is string => !!v);
    const companyById = accountIds.length === 0
      ? new Map<string, typeof companies.$inferSelect>()
      : new Map((await db.select().from(companies).where(inArray(companies.id, accountIds))).map(c => [c.id, c] as const));

    return threads.map(t => {
      const co = t.linkedAccountId ? companyById.get(t.linkedAccountId) ?? null : null;
      const isHigh = t.responsePriority === "high";
      // Base urgency: high → 80, normal → 50, low → 30. The HOT_REPLY_FLOOR
      // applied in the ranker is what guarantees these dominate the queue;
      // the urgency score here is just for the badge displayed on the row.
      const urgencyScore = isHigh ? 80 : t.responsePriority === "low" ? 30 : 50;
      const ageMin = ageMinutesSince(t.lastIncomingAt ?? t.waitingSinceAt, ctx.now);
      const reason = isHigh
        ? "High-priority reply waiting"
        : ageMin !== null && ageMin > 60 * 24
          ? `Waiting ${Math.round(ageMin / 60)}h`
          : "Reply waiting";
      return {
        id: `hot_reply:${t.id}`,
        source: "hot_reply" as const,
        sourceId: t.id,
        summary: `${co?.name ?? "Unknown account"} — reply waiting`,
        urgencyScore,
        urgencyLevel: urgencyLevelFromScore(urgencyScore),
        priorityScore: 0,
        reason,
        primaryActionLabel: "Reply",
        primaryAction: "reply" as const,
        deepLink: `/conversations?threadId=${encodeURIComponent(t.threadId)}`,
        customerName: co?.name ?? null,
        ageMinutes: ageMin,
        // Floor only applies to high-priority threads; normal/low replies
        // are still surfaced but ranked alongside freight ops + LWQ.
        isHotReply: isHigh,
      };
    });
  } catch (err) {
    console.error("[todayQueue] hot-reply fetch failed:", err);
    return [];
  }
}

// Quote SLA — pending quotes that are over their SLA OR expiring today.
// getActionQueue is org-scoped; we filter to this rep's customers via the
// underlying customer rows. Returns the union (de-duped) of breached + expiring.
async function fetchQuoteSlaItems(ctx: SourceContext): Promise<TodayQueueItem[]> {
  try {
    const queue = await getActionQueue(ctx.orgId, { limit: 50, now: ctx.now.getTime() });
    const merged = Array.from(new Map(
      [...queue.slaBreaching, ...queue.expiringToday].map(q => [q.id, q] as const),
    ).values());
    if (merged.length === 0) return [];

    // Today queue is per-user: only show SLA breaches on customers this rep
    // owns. We use companies.salesPersonId as the canonical "rep owns this
    // account" link (mirrors what the rest of the CRM uses for ownership).
    const customerIds = Array.from(new Set(
      merged.map(q => q.customerId).filter((v): v is string => !!v),
    ));
    const ownedCustomerIds = new Set<string>();
    if (customerIds.length > 0) {
      const ownedRows = await db.select({ id: companies.id })
        .from(companies)
        .where(and(
          eq(companies.organizationId, ctx.orgId),
          inArray(companies.id, customerIds),
          eq(companies.salesPersonId, ctx.userId),
        ));
      for (const row of ownedRows) ownedCustomerIds.add(row.id);
    }
    const scoped = merged.filter(q => q.customerId && ownedCustomerIds.has(q.customerId));
    if (scoped.length === 0) return [];

    return scoped.map(q => {
      const isBreached = q.slaState === "breached";
      const ageMin = q.minutesSinceRequest ?? null;
      // Composite urgency: breached SLA gets a flat 90, expiring today 70.
      const urgencyScore = isBreached ? 90 : 70;
      const reason = isBreached
        ? `SLA breached — ${ageMin ? Math.round(ageMin) : "?"}m old`
        : "Expiring today";
      const lane = `${q.originCity}, ${q.originState.toUpperCase()} → ${q.destCity}, ${q.destState.toUpperCase()}`;
      return {
        id: `quote_sla:${q.id}`,
        source: "quote_sla" as const,
        sourceId: q.id,
        summary: `${lane} • ${q.customerName ?? "—"}`,
        urgencyScore,
        urgencyLevel: urgencyLevelFromScore(urgencyScore),
        priorityScore: 0,
        reason,
        primaryActionLabel: "Quote now",
        primaryAction: "quote_now" as const,
        deepLink: `/customer-quotes?quoteId=${encodeURIComponent(q.id)}`,
        customerName: q.customerName ?? null,
        ageMinutes: ageMin,
      };
    });
  } catch (err) {
    console.error("[todayQueue] quote-sla fetch failed:", err);
    return [];
  }
}


// ── Snoozes ────────────────────────────────────────────────────────────────

async function loadActiveSnoozes(orgId: string, userId: string, now: Date): Promise<Set<string>> {
  const rows = await db.select({ source: todayQueueSnoozes.source, sourceId: todayQueueSnoozes.sourceId })
    .from(todayQueueSnoozes)
    .where(and(
      eq(todayQueueSnoozes.orgId, orgId),
      eq(todayQueueSnoozes.userId, userId),
      gt(todayQueueSnoozes.snoozedUntil, now),
    ));
  return new Set(rows.map(r => `${r.source}:${r.sourceId}`));
}


// ── Public entry point ─────────────────────────────────────────────────────

export interface GetTodayQueueOptions {
  limit?: number;
  cursor?: string | null;
  now?: Date;
}

/**
 * Pure composer: takes already-pulled source items, the active snooze set,
 * and a customerName → tier index, applies the snooze filter, ranks, and
 * paginates. Exported so integration tests can exercise the composition
 * (snooze hide/re-surface, source diversity, end-to-end priority ordering)
 * without standing up the full DB layer.
 */
export function composeTodayQueue(input: {
  sources: { lwq: TodayQueueItem[]; freight_opp: TodayQueueItem[]; hot_reply: TodayQueueItem[]; quote_sla: TodayQueueItem[] };
  snoozedIds: Set<string>;
  tierByCustomer: Map<string, string | null>;
  limit: number;
  cursor: number;
}): TodayQueueResponse {
  const { sources, snoozedIds, tierByCustomer, limit, cursor } = input;
  const all = [
    ...sources.lwq,
    ...sources.freight_opp,
    ...sources.hot_reply,
    ...sources.quote_sla,
  ].filter(it => !snoozedIds.has(it.id));

  const rankedAll = rankTodayItems(all.map(it => ({
    ...it,
    customerTier: it.customerName ? tierByCustomer.get(it.customerName) ?? null : null,
  })));

  const finalItems: TodayQueueItem[] = rankedAll.map(({ priorityScore, ...rest }) => ({
    ...rest,
    priorityScore,
  }));

  const pageStart = cursor;
  const page = finalItems.slice(pageStart, pageStart + limit);
  const nextCursor = pageStart + page.length < finalItems.length
    ? String(pageStart + page.length)
    : null;

  const bySource: TodayQueueResponse["bySource"] = {
    lwq: 0, freight_opp: 0, hot_reply: 0, quote_sla: 0,
  };
  for (const it of finalItems) bySource[it.source]++;

  return {
    items: page,
    nextCursor,
    totalBeforePagination: finalItems.length,
    generatedAt: new Date().toISOString(),
    bySource,
  };
}

/**
 * Aggregator entry point. Runs the four source-pulls in parallel, applies
 * the per-user snooze filter, ranks the unified list, and returns the
 * paginated page. `cursor` is a 1-based "page" cursor — small ints over
 * a stable sort are sufficient for ~50-item queues; we don't need keyset.
 */
export async function getTodayQueue(
  orgId: string,
  userId: string,
  opts: GetTodayQueueOptions = {},
): Promise<TodayQueueResponse> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const cursor = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;

  const ctx: SourceContext = { orgId, userId, now };

  const [lwq, opps, replies, quotes, snoozedIds] = await Promise.all([
    fetchLwqItems(ctx),
    fetchFreightOppItems(ctx),
    fetchHotReplyItems(ctx),
    fetchQuoteSlaItems(ctx),
    loadActiveSnoozes(orgId, userId, now),
  ]);

  // Build customerName → tier from the union of pulled items; companies
  // backing freight_opps are already loaded, but LWQ/hot_reply/quote_sla
  // rows arrive without a tier so we resolve them with one batch query.
  const tierByCustomer = new Map<string, string | null>();
  for (const it of [...lwq, ...opps, ...replies, ...quotes]) {
    if (it.customerName && !tierByCustomer.has(it.customerName)) {
      tierByCustomer.set(it.customerName, null);
    }
  }
  const customerNames = Array.from(tierByCustomer.keys());
  if (customerNames.length > 0) {
    const rows = await db.select({
      name: companies.name,
      estimatedFreightSpend: companies.estimatedFreightSpend,
    }).from(companies).where(and(eq(companies.organizationId, orgId), inArray(companies.name, customerNames)));
    for (const r of rows) {
      const tier = deriveCustomerTier(r.estimatedFreightSpend);
      if (tier) tierByCustomer.set(r.name, tier);
    }
  }

  return composeTodayQueue({
    sources: { lwq, freight_opp: opps, hot_reply: replies, quote_sla: quotes },
    snoozedIds,
    tierByCustomer,
    limit,
    cursor,
  });
}

// ── Snooze + unsnooze (used by the routes module) ──────────────────────────

export interface SnoozeArgs {
  orgId: string;
  userId: string;
  source: TodayQueueSource;
  sourceId: string;
  hours: number;
  reason?: string | null;
  now?: Date;
}

export async function snoozeTodayItem(args: SnoozeArgs): Promise<{ snoozedUntil: Date }> {
  const now = args.now ?? new Date();
  const snoozedUntil = new Date(now.getTime() + args.hours * 60 * 60 * 1000);
  await db.insert(todayQueueSnoozes).values({
    orgId: args.orgId,
    userId: args.userId,
    source: args.source,
    sourceId: args.sourceId,
    snoozedUntil,
    reason: args.reason ?? null,
  }).onConflictDoUpdate({
    target: [todayQueueSnoozes.userId, todayQueueSnoozes.source, todayQueueSnoozes.sourceId],
    // Preserve the original createdAt on re-snooze (audit metadata) — only
    // refresh the window and the reason.
    set: { snoozedUntil, reason: args.reason ?? null },
  });
  // Audit trail — the snooze row itself is the audit record (it carries
  // user, timestamp, reason). We additionally log to the server log so the
  // event shows up in operator-facing log search.
  console.log(`[todayQueue] snooze user=${args.userId} ${args.source}:${args.sourceId} until=${snoozedUntil.toISOString()} reason="${args.reason ?? ""}"`);
  return { snoozedUntil };
}

export async function unsnoozeTodayItem(args: {
  orgId: string;
  userId: string;
  source: TodayQueueSource;
  sourceId: string;
}): Promise<void> {
  await db.delete(todayQueueSnoozes).where(and(
    eq(todayQueueSnoozes.orgId, args.orgId),
    eq(todayQueueSnoozes.userId, args.userId),
    eq(todayQueueSnoozes.source, args.source),
    eq(todayQueueSnoozes.sourceId, args.sourceId),
  ));
  console.log(`[todayQueue] unsnooze user=${args.userId} ${args.source}:${args.sourceId}`);
}
