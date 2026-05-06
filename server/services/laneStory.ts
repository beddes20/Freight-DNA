// Task #873 — Lane Story service.
//
// Builds the per-lane "story" payload (header strip, timeline, outcomes-30d)
// for the Lane Story page (`/lanes/story/:laneSignature`). Reuses the same
// cross-surface event sources the Lane Inbox already pulls from — no new
// event producers are introduced here.
//
// The signature is the canonical lane key produced by `laneSig` in
// server/laneCrossLinkService.ts (origin|originState|destination|
// destinationState|equipment, all lowercased + trimmed).

import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  recurringLanes,
  freightOpportunities,
  freightOpportunityAudit,
  carrierOutreachLogs,
  quoteEvents,
  quoteOpportunities,
  quoteCustomers,
  loadFact,
  users,
  type RecurringLane,
} from "@shared/schema";
import { laneSig } from "../laneCrossLinkService";

export interface LaneStoryHeader {
  laneSignature: string;
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  laneScore: number | null;
  laneScoreFactors: unknown;
  laneHealth: "healthy" | "warming" | "leaking" | "unknown";
  carriersContactedCount: number;
  contactableCount: number; // 0 means "no contactable" flag
  liveOppCount: number;
  freshnessMinutes: number | null;
}

export type LaneStoryEventSurface =
  | "available_freight"
  | "lane_work_queue"
  | "customer_quotes"
  | "carrier_hub";

export interface LaneStoryEvent {
  id: string;
  surface: LaneStoryEventSurface;
  kind: string;
  title: string;
  detail: string;
  occurredAt: string;
  actor: string | null;
  refId: string | null;
}

export interface LaneStoryTimeline {
  events: LaneStoryEvent[];
  nextCursor: string | null;
}

export interface LaneStoryOutcomes30d {
  windowStart: string;
  windowEnd: string;
  covers: { count: number; combinedGrossMargin: number };
  quotes: { won: number; lost: number };
  outreachWaves: number;
  carrierReplies: number;
  distinctCarriersContacted: number;
}

export interface LaneStoryPayload {
  header: LaneStoryHeader;
  timeline: LaneStoryTimeline;
  outcomes30d: LaneStoryOutcomes30d;
}

export interface LaneStoryNotRecurring {
  recurring: false;
  prefill: {
    originCity: string;
    originState: string;
    destCity: string;
    destState: string;
    equipment: string;
  };
}

const TIMELINE_PAGE_SIZE = 50;

/** Parse a canonical lane signature back into its 5 parts. */
export function parseLaneSignature(sig: string): {
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string;
} | null {
  if (typeof sig !== "string") return null;
  const parts = sig.split("|");
  if (parts.length !== 5) return null;
  return {
    origin: parts[0] ?? "",
    originState: parts[1] ?? "",
    destination: parts[2] ?? "",
    destinationState: parts[3] ?? "",
    equipmentType: parts[4] ?? "",
  };
}

/** Locate every recurring lane in the org whose canonical signature matches. */
export async function findRecurringLanesBySig(
  db: any,
  orgId: string,
  signature: string,
): Promise<RecurringLane[]> {
  const lanes = await db
    .select()
    .from(recurringLanes)
    .where(eq(recurringLanes.orgId, orgId));
  return (lanes as RecurringLane[]).filter((l) =>
    laneSig(l.origin, l.originState, l.destination, l.destinationState, l.equipmentType) === signature,
  );
}

/** Compute lane health from the recurring-lane snapshot. */
export function deriveLaneHealth(
  contactedCount: number,
  laneScore: number | null,
): LaneStoryHeader["laneHealth"] {
  if (laneScore === null) return "unknown";
  if (contactedCount >= 3 && laneScore >= 70) return "healthy";
  if (contactedCount === 0) return "leaking";
  if (laneScore < 40) return "leaking";
  return "warming";
}

/**
 * Build the header strip — lane identity + current health snapshot.
 *
 * Picks the highest-scored matching recurring lane when multiple exist (rare,
 * but possible if duplicates were created before #635 normalized signatures).
 */
export async function buildLaneStoryHeader(
  db: any,
  orgId: string,
  signature: string,
  lanes: RecurringLane[],
  now: Date,
): Promise<LaneStoryHeader> {
  // Pick the canonical lane: highest score, then earliest createdAt.
  const lane = [...lanes].sort((a, b) => {
    const sa = a.laneScore ?? -1;
    const sb = b.laneScore ?? -1;
    if (sa !== sb) return sb - sa;
    const ta = a.createdAt ? new Date(a.createdAt as any).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt as any).getTime() : 0;
    return ta - tb;
  })[0];

  let ownerName: string | null = null;
  if (lane.ownerUserId) {
    const ownerRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, lane.ownerUserId))
      .limit(1);
    ownerName = (ownerRows[0]?.name as string | undefined) ?? null;
  }

  // Live AF count: open opportunities for this signature today.
  const OPEN_STATUSES = [
    "new",
    "ready_to_send",
    "sent",
    "awaiting_carrier_reply",
    "awaiting_customer_confirm",
    "partially_covered",
  ];
  const openOpps = await db
    .select({
      id: freightOpportunities.id,
      origin: freightOpportunities.origin,
      originState: freightOpportunities.originState,
      destination: freightOpportunities.destination,
      destinationState: freightOpportunities.destinationState,
      equipmentType: freightOpportunities.equipmentType,
      generatedAt: freightOpportunities.generatedAt,
    })
    .from(freightOpportunities)
    .where(
      and(
        eq(freightOpportunities.orgId, orgId),
        inArray(freightOpportunities.status, OPEN_STATUSES),
      ),
    );
  const matchingOpps = (openOpps as any[]).filter((o) =>
    laneSig(o.origin, o.originState, o.destination, o.destinationState, o.equipmentType) === signature,
  );
  const liveOppCount = matchingOpps.length;
  const newestOpp = matchingOpps
    .map((o) => (o.generatedAt instanceof Date ? o.generatedAt.getTime() : new Date(o.generatedAt).getTime()))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  const freshnessMinutes = newestOpp
    ? Math.max(0, Math.round((now.getTime() - newestOpp) / 60_000))
    : null;

  // Contactable count is opportunistically fetched from lane_carrier_interest
  // (rough proxy: count with interestStatus in ("available_now",
  // "available_next_week")). When 0, the header surfaces a "no contactable"
  // flag, mirroring the LWQ row.
  const interestRows = await db.execute(sql`
    SELECT count(*)::int AS count
      FROM lane_carrier_interest
     WHERE lane_id = ${lane.id}
       AND interest_status IN ('available_now','available_next_week')
  `);
  const contactableCount = Number(
    (interestRows as any)?.rows?.[0]?.count
      ?? (Array.isArray(interestRows) ? (interestRows as any)[0]?.count : 0)
      ?? 0,
  );

  return {
    laneSignature: signature,
    laneId: lane.id,
    origin: lane.origin,
    originState: lane.originState,
    destination: lane.destination,
    destinationState: lane.destinationState,
    equipmentType: lane.equipmentType,
    companyId: lane.companyId,
    companyName: lane.companyName,
    ownerUserId: lane.ownerUserId,
    ownerName,
    laneScore: lane.laneScore,
    laneScoreFactors: lane.laneScoreFactors,
    laneHealth: deriveLaneHealth(lane.carriersContactedCount ?? 0, lane.laneScore ?? null),
    carriersContactedCount: lane.carriersContactedCount ?? 0,
    contactableCount,
    liveOppCount,
    freshnessMinutes,
  };
}

/**
 * Build the chronological cross-surface timeline. Pages by an `occurredAt`
 * cursor (newest first). Each surface is capped at the page size so a noisy
 * surface can't crowd out the others mid-page.
 */
export async function buildLaneStoryTimeline(
  db: any,
  orgId: string,
  signature: string,
  laneIds: string[],
  cursor: string | null,
): Promise<LaneStoryTimeline> {
  const cursorTs = cursor ? new Date(cursor) : null;

  // ── Available Freight audit events ──────────────────────────────────────
  const meaningfulAudit = [
    "approved",
    "status_changed",
    "response_recorded",
    "sla_escalated",
    "sla_nudged",
    "expired",
    "cancelled",
  ];
  const afRows = await db
    .select({
      id: freightOpportunityAudit.id,
      eventType: freightOpportunityAudit.eventType,
      createdAt: freightOpportunityAudit.createdAt,
      opportunityId: freightOpportunityAudit.opportunityId,
      actorUserId: freightOpportunityAudit.actorUserId,
      payload: freightOpportunityAudit.payload,
      origin: freightOpportunities.origin,
      originState: freightOpportunities.originState,
      destination: freightOpportunities.destination,
      destinationState: freightOpportunities.destinationState,
      equipmentType: freightOpportunities.equipmentType,
    })
    .from(freightOpportunityAudit)
    .innerJoin(freightOpportunities, eq(freightOpportunityAudit.opportunityId, freightOpportunities.id))
    .where(
      and(
        eq(freightOpportunities.orgId, orgId),
        inArray(freightOpportunityAudit.eventType, meaningfulAudit),
        ...(cursorTs ? [lt(freightOpportunityAudit.createdAt, cursorTs)] : []),
      ),
    )
    .orderBy(desc(freightOpportunityAudit.createdAt))
    .limit(TIMELINE_PAGE_SIZE);

  const afEvents: LaneStoryEvent[] = (afRows as any[])
    .filter((r) =>
      laneSig(r.origin, r.originState, r.destination, r.destinationState, r.equipmentType) === signature,
    )
    .map((r) => ({
      id: `af:${r.id}`,
      surface: "available_freight" as const,
      kind: r.eventType,
      title: `Opportunity ${String(r.eventType).replace(/_/g, " ")}`,
      detail: r.payload ? JSON.stringify(r.payload).slice(0, 400) : "",
      occurredAt: (r.createdAt as Date).toISOString(),
      actor: r.actorUserId ?? null,
      refId: r.opportunityId,
    }));

  // ── LWQ + Carrier Hub outreach + replies ────────────────────────────────
  let outreachRows: any[] = [];
  if (laneIds.length > 0) {
    outreachRows = await db
      .select({
        id: carrierOutreachLogs.id,
        laneId: carrierOutreachLogs.laneId,
        timestamp: carrierOutreachLogs.timestamp,
        sentAt: carrierOutreachLogs.sentAt,
        replyReceivedAt: carrierOutreachLogs.replyReceivedAt,
        outreachMode: carrierOutreachLogs.outreachMode,
        direction: carrierOutreachLogs.direction,
        carrierNames: carrierOutreachLogs.carrierNames,
        actorUserId: carrierOutreachLogs.actorUserId,
        replySnippet: carrierOutreachLogs.replySnippet,
        bodyPreview: carrierOutreachLogs.bodyPreview,
      })
      .from(carrierOutreachLogs)
      .where(
        and(
          eq(carrierOutreachLogs.orgId, orgId),
          inArray(carrierOutreachLogs.laneId, laneIds),
          or(
            isNotNull(carrierOutreachLogs.sentAt),
            isNotNull(carrierOutreachLogs.replyReceivedAt),
            eq(carrierOutreachLogs.outreachMode, "reassignment"),
          ),
          ...(cursorTs ? [lt(carrierOutreachLogs.timestamp, cursorTs)] : []),
        ),
      )
      .orderBy(desc(carrierOutreachLogs.timestamp))
      .limit(TIMELINE_PAGE_SIZE);
  }
  const outreachEvents: LaneStoryEvent[] = outreachRows.map((r) => {
    const isReply = !!r.replyReceivedAt || r.direction === "inbound";
    const surface: LaneStoryEventSurface = isReply ? "carrier_hub" : "lane_work_queue";
    const carrierLabel = (r.carrierNames ?? []).slice(0, 2).join(", ") || "Carrier";
    let kind: string;
    let title: string;
    let detail: string;
    if (isReply) {
      kind = "reply";
      title = `${carrierLabel} replied`;
      detail = (r.replySnippet ?? r.bodyPreview ?? "").slice(0, 400);
    } else if (r.outreachMode === "reassignment") {
      kind = "reassigned";
      title = "Lane reassigned";
      detail = "";
    } else {
      kind = "outreach_sent";
      title = `Outreach sent to ${carrierLabel}`;
      detail = "";
    }
    const ts = (r.replyReceivedAt ?? r.sentAt ?? r.timestamp) as Date;
    return {
      id: `outreach:${r.id}`,
      surface,
      kind,
      title,
      detail,
      occurredAt: ts.toISOString(),
      actor: r.actorUserId ?? null,
      refId: r.laneId,
    };
  });

  // ── Quote outcome events ────────────────────────────────────────────────
  const meaningfulQuoteEvents = ["won", "lost", "outcome_changed", "ignored"];
  const quoteRows = await db
    .select({
      id: quoteEvents.id,
      quoteId: quoteEvents.quoteId,
      eventType: quoteEvents.eventType,
      occurredAt: quoteEvents.occurredAt,
      payload: quoteEvents.payload,
      originCity: quoteOpportunities.originCity,
      originState: quoteOpportunities.originState,
      destCity: quoteOpportunities.destCity,
      destState: quoteOpportunities.destState,
      equipment: quoteOpportunities.equipment,
      customerName: quoteCustomers.name,
    })
    .from(quoteEvents)
    .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
    .leftJoin(quoteCustomers, eq(quoteOpportunities.customerId, quoteCustomers.id))
    .where(
      and(
        eq(quoteOpportunities.organizationId, orgId),
        inArray(quoteEvents.eventType, meaningfulQuoteEvents),
        ...(cursorTs ? [lt(quoteEvents.occurredAt, cursorTs)] : []),
      ),
    )
    .orderBy(desc(quoteEvents.occurredAt))
    .limit(TIMELINE_PAGE_SIZE);
  const quoteEventsOut: LaneStoryEvent[] = (quoteRows as any[])
    .filter((r) =>
      laneSig(r.originCity, r.originState, r.destCity, r.destState, r.equipment) === signature,
    )
    .map((r) => ({
      id: `quote:${r.id}`,
      surface: "customer_quotes" as const,
      kind: r.eventType,
      title: `Quote ${String(r.eventType).replace(/_/g, " ")}${r.customerName ? ` — ${r.customerName}` : ""}`,
      detail: r.payload ? JSON.stringify(r.payload).slice(0, 400) : "",
      occurredAt: (r.occurredAt as Date).toISOString(),
      actor: null,
      refId: r.quoteId,
    }));

  // Merge, sort newest-first, trim to page size, compute next cursor.
  const merged = [...afEvents, ...outreachEvents, ...quoteEventsOut].sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : -1,
  );
  const trimmed = merged.slice(0, TIMELINE_PAGE_SIZE);
  const nextCursor =
    merged.length > TIMELINE_PAGE_SIZE && trimmed.length > 0
      ? trimmed[trimmed.length - 1].occurredAt
      : null;
  return { events: trimmed, nextCursor };
}

/** Trailing-30d outcomes summary. */
export async function buildLaneStoryOutcomes30d(
  db: any,
  orgId: string,
  signature: string,
  laneIds: string[],
  now: Date,
): Promise<LaneStoryOutcomes30d> {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Covers + GM from load_fact (filtered by signature in JS). The fact table
  // has free-text origin/dest; signature normalization makes them safe to
  // compare regardless of casing/whitespace.
  const facts = await db
    .select({
      id: loadFact.id,
      originCity: loadFact.originCity,
      originState: loadFact.originState,
      destinationCity: loadFact.destinationCity,
      destinationState: loadFact.destinationState,
      equipmentType: loadFact.equipmentType,
      revenue: loadFact.revenue,
      cost: loadFact.cost,
      margin: loadFact.margin,
      bucket: loadFact.bucket,
      lastChangedAt: loadFact.lastChangedAt,
    })
    .from(loadFact)
    .where(
      and(
        eq(loadFact.orgId, orgId),
        gte(loadFact.lastChangedAt, windowStart),
      ),
    );
  const matchedFacts = (facts as any[]).filter((f) =>
    laneSig(f.originCity, f.originState, f.destinationCity, f.destinationState, f.equipmentType) === signature
    && (f.bucket === "realized" || f.bucket === "active"),
  );
  const coversCount = matchedFacts.length;
  const combinedGrossMargin = matchedFacts.reduce((acc, f) => {
    const m = f.margin != null ? Number(f.margin) : (
      f.revenue != null && f.cost != null ? Number(f.revenue) - Number(f.cost) : 0
    );
    return acc + (Number.isFinite(m) ? m : 0);
  }, 0);

  // Quote outcomes from quote_events (won / lost) joined to opportunity geography.
  const quoteRows = await db
    .select({
      eventType: quoteEvents.eventType,
      occurredAt: quoteEvents.occurredAt,
      originCity: quoteOpportunities.originCity,
      originState: quoteOpportunities.originState,
      destCity: quoteOpportunities.destCity,
      destState: quoteOpportunities.destState,
      equipment: quoteOpportunities.equipment,
    })
    .from(quoteEvents)
    .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
    .where(
      and(
        eq(quoteOpportunities.organizationId, orgId),
        inArray(quoteEvents.eventType, ["won", "lost"]),
        gte(quoteEvents.occurredAt, windowStart),
      ),
    );
  let won = 0;
  let lost = 0;
  for (const r of quoteRows as any[]) {
    if (laneSig(r.originCity, r.originState, r.destCity, r.destState, r.equipment) !== signature) continue;
    if (r.eventType === "won") won += 1;
    else if (r.eventType === "lost") lost += 1;
  }

  // Outreach waves + replies + distinct carriers from carrier_outreach_logs.
  let outreachWaves = 0;
  let carrierReplies = 0;
  const distinctCarriers = new Set<string>();
  if (laneIds.length > 0) {
    const outRows = await db
      .select({
        id: carrierOutreachLogs.id,
        sentAt: carrierOutreachLogs.sentAt,
        replyReceivedAt: carrierOutreachLogs.replyReceivedAt,
        carrierIds: carrierOutreachLogs.carrierIds,
      })
      .from(carrierOutreachLogs)
      .where(
        and(
          eq(carrierOutreachLogs.orgId, orgId),
          inArray(carrierOutreachLogs.laneId, laneIds),
          gte(carrierOutreachLogs.timestamp, windowStart),
        ),
      );
    for (const r of outRows as any[]) {
      if (r.sentAt) {
        outreachWaves += 1;
        for (const id of (r.carrierIds ?? []) as string[]) {
          if (id) distinctCarriers.add(id);
        }
      }
      if (r.replyReceivedAt) carrierReplies += 1;
    }
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    covers: { count: coversCount, combinedGrossMargin: Math.round(combinedGrossMargin * 100) / 100 },
    quotes: { won, lost },
    outreachWaves,
    carrierReplies,
    distinctCarriersContacted: distinctCarriers.size,
  };
}

/**
 * Group the flat Lane Inbox feed by canonical lane signature.
 * Returns one entry per lane with the last `keepLast` events, sorted by
 * the most recent event timestamp. Rows that lack lane info are dropped
 * (we cannot key them to a story).
 */
export interface LaneInboxGroupRow {
  laneSignature: string;
  lane: string;
  laneId: string | null;
  companyName: string | null;
  ownerName: string | null;
  events: Array<{
    id: string;
    surface: string;
    kind: string;
    title: string;
    subtitle: string;
    occurredAt: string;
    deepLink: string;
    refId: string | null;
  }>;
  mostRecentAt: string;
  totalEvents: number;
  storyHref: string;
}

export interface FlatInboxRowLike {
  id: string;
  surface: string;
  kind: string;
  title: string;
  subtitle: string;
  occurredAt: string;
  deepLink: string;
  lane: string | null;
  refId: string | null;
  origin?: string | null;
  originState?: string | null;
  destination?: string | null;
  destinationState?: string | null;
  equipmentType?: string | null;
}

export function groupLaneInboxBySig(
  rows: FlatInboxRowLike[],
  laneMeta: Map<string, { laneId: string | null; companyName: string | null; ownerName: string | null }>,
  keepLast = 3,
): LaneInboxGroupRow[] {
  const buckets = new Map<string, LaneInboxGroupRow>();
  for (const r of rows) {
    const sig = laneSig(
      r.origin ?? null,
      r.originState ?? null,
      r.destination ?? null,
      r.destinationState ?? null,
      r.equipmentType ?? null,
    );
    // Skip rows where we cannot derive any lane parts — they have no story home.
    if (sig === "||||") continue;
    const existing = buckets.get(sig);
    const evt = {
      id: r.id,
      surface: r.surface,
      kind: r.kind,
      title: r.title,
      subtitle: r.subtitle,
      occurredAt: r.occurredAt,
      deepLink: r.deepLink,
      refId: r.refId,
    };
    if (!existing) {
      const meta = laneMeta.get(sig);
      buckets.set(sig, {
        laneSignature: sig,
        lane: r.lane ?? "Unknown lane",
        laneId: meta?.laneId ?? null,
        companyName: meta?.companyName ?? null,
        ownerName: meta?.ownerName ?? null,
        events: [evt],
        mostRecentAt: r.occurredAt,
        totalEvents: 1,
        storyHref: `/lanes/story/${encodeURIComponent(sig)}`,
      });
    } else {
      existing.totalEvents += 1;
      existing.events.push(evt);
      // Most recent first, then keep only the first `keepLast`.
      existing.events.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
      if (existing.events.length > keepLast) existing.events.length = keepLast;
      if (r.occurredAt > existing.mostRecentAt) existing.mostRecentAt = r.occurredAt;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => (a.mostRecentAt < b.mostRecentAt ? 1 : -1));
}
