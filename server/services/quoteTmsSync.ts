/**
 * TMS → Quote Outcome Sync (Task #470)
 *
 * Pending quote opportunities sit in the dashboard until either the rep marks
 * them won/lost or the TMS confirms what actually happened. This service walks
 * pending/active quotes for an org and reconciles them against `load_fact`
 * rows imported from the TMS:
 *
 *   - Match by `sourceReference == load_fact.order_id` (preferred — the rep's
 *     reply usually quotes the TMS order number) OR by best-effort
 *     customer + lane + pickup-date proximity (within 14 days of requestDate).
 *   - Realized loads (`bucket = "realized"`) flip the quote to `won` and
 *     populate `carrier_paid` from the load's `cost`.
 *   - Cancelled loads (`bucket = "cancelled"`) flip the quote to a
 *     `lost_timing` outcome — the customer pulled the freight before it
 *     could be covered.
 *   - Pending quotes whose `valid_through` has passed without any matching
 *     TMS load flip to `expired`.
 *
 * Each transition writes a `tms_won`, `tms_lost`, or `tms_expired` row into
 * `quote_events` so the timeline shows the source of truth that closed it.
 *
 * Idempotent: rows already in a terminal status are skipped.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  loadFact, quoteOpportunities, quoteEvents, quoteCustomers, quoteCarriers,
  quoteOutcomeReasons,
  type LoadFact, type QuoteOpportunity,
} from "@shared/schema";
import { logQuoteTouchpointFromEvent } from "./quoteTouchpoints";

const ACTIVE_OUTCOMES = ["pending"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_WINDOW_MS = 14 * DAY_MS;

export interface SyncResult {
  scanned: number;
  won: number;
  lost: number;
  expired: number;
  unchanged: number;
}

function num(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Number(v); return isFinite(n) ? n : 0;
}

function laneEquals(opp: QuoteOpportunity, fact: LoadFact): boolean {
  const a = `${(fact.originCity ?? "").toLowerCase().trim()},${(fact.originState ?? "").toLowerCase().trim()}`;
  const b = `${(fact.destinationCity ?? "").toLowerCase().trim()},${(fact.destinationState ?? "").toLowerCase().trim()}`;
  const oa = `${opp.originCity.toLowerCase().trim()},${opp.originState.toLowerCase().trim()}`;
  const ob = `${opp.destCity.toLowerCase().trim()},${opp.destState.toLowerCase().trim()}`;
  return a === oa && b === ob;
}

function customerMatches(custName: string, fact: LoadFact): boolean {
  const factName = (fact.customerName ?? "").toLowerCase().trim();
  if (!factName) return false;
  const c = custName.toLowerCase().trim();
  if (factName === c) return true;
  // Tolerate suffixes like " Inc", " LLC" on either side.
  const stripped = (s: string) => s.replace(/\b(inc|llc|co|corp|ltd|company)\b\.?/g, "").trim();
  return stripped(factName) === stripped(c);
}

export type SyncDecision =
  | { kind: "won"; match: LoadFact; lowMargin: boolean; cost: number; revenue: number }
  | { kind: "lost"; match: LoadFact }
  | { kind: "expired" }
  | { kind: "unchanged" };

/**
 * Pure decision function — exposed for unit testing. Decides what action to
 * take for a single quote opportunity given the candidate TMS facts.
 */
export function decideSyncAction(
  opp: QuoteOpportunity,
  customerName: string,
  facts: LoadFact[],
  now: number,
): SyncDecision {
  let match: LoadFact | undefined;
  if (opp.sourceReference) {
    const ref = opp.sourceReference.toLowerCase();
    match = facts.find(f => (f.orderId ?? "").toLowerCase() === ref);
  }
  if (!match) {
    match = facts.find(f =>
      customerMatches(customerName, f) && laneEquals(opp, f) && pickupNear(opp, f),
    );
  }

  if (match && match.bucket === "cancelled") {
    return { kind: "lost", match };
  }
  if (match && match.bucket === "realized") {
    const cost = num(match.cost as unknown as string | null);
    const revenue = num(match.revenue as unknown as string | null);
    const quoted = num(opp.quotedAmount) || revenue;
    const margin = quoted - cost;
    const lowMargin = quoted > 0 && margin > 0 && margin / quoted < 0.06;
    return { kind: "won", match, lowMargin, cost, revenue };
  }
  if (opp.validThrough && opp.validThrough.getTime() < now) {
    return { kind: "expired" };
  }
  return { kind: "unchanged" };
}

function pickupNear(opp: QuoteOpportunity, fact: LoadFact): boolean {
  if (!fact.pickupDate) return true; // can't enforce — accept
  const t = Date.parse(fact.pickupDate);
  if (!isFinite(t)) return true;
  return Math.abs(t - opp.requestDate.getTime()) <= MATCH_WINDOW_MS;
}

async function findOrCreateLostTimingReason(orgId: string): Promise<string> {
  const existing = await db.select().from(quoteOutcomeReasons)
    .where(and(eq(quoteOutcomeReasons.organizationId, orgId), eq(quoteOutcomeReasons.code, "lost_timing")))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db.insert(quoteOutcomeReasons).values({
    organizationId: orgId,
    code: "lost_timing",
    label: "Couldn't meet pickup",
    category: "lost",
  }).returning();
  return row.id;
}

async function findOrCreateCarrier(orgId: string, name: string | null): Promise<string | null> {
  if (!name || !name.trim()) return null;
  const existing = await db.select().from(quoteCarriers)
    .where(and(eq(quoteCarriers.organizationId, orgId), eq(quoteCarriers.name, name)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db.insert(quoteCarriers).values({ organizationId: orgId, name }).returning();
  return row.id;
}

/**
 * Reconcile pending quote opportunities for an org against the TMS load_fact
 * table. Safe to run on a schedule (idempotent + bounded).
 */
export async function syncQuoteOutcomesFromTms(orgId: string): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, won: 0, lost: 0, expired: 0, unchanged: 0 };

  const opps = await db.select().from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    inArray(quoteOpportunities.outcomeStatus, ACTIVE_OUTCOMES as unknown as string[]),
  ));
  if (opps.length === 0) return result;
  result.scanned = opps.length;

  const customers = await db.select().from(quoteCustomers)
    .where(eq(quoteCustomers.organizationId, orgId));
  const customerById = new Map(customers.map(c => [c.id, c]));

  // Pull all candidate load_fact rows for the org once. In production this
  // would be paginated; the volumes during pilot are small.
  const facts = await db.select().from(loadFact).where(eq(loadFact.orgId, orgId));

  const now = Date.now();

  for (const opp of opps) {
    const cust = customerById.get(opp.customerId);
    if (!cust) { result.unchanged++; continue; }

    const decision = decideSyncAction(opp, cust.name, facts, now);

    if (decision.kind === "lost") {
      const reasonId = await findOrCreateLostTimingReason(opp.organizationId);
      await db.update(quoteOpportunities)
        .set({ outcomeStatus: "lost_timing", outcomeReasonId: reasonId })
        .where(eq(quoteOpportunities.id, opp.id));
      const [lostEv] = await db.insert(quoteEvents).values({
        quoteId: opp.id,
        eventType: "tms_lost",
        occurredAt: new Date(),
        actor: "TMS",
        payload: {
          orderId: decision.match.orderId,
          bucket: decision.match.bucket,
          moveStatus: decision.match.moveStatus,
          reason: "TMS load cancelled before coverage",
        },
      }).returning();
      await logQuoteTouchpointFromEvent({
        orgId: opp.organizationId, oppId: opp.id, eventId: lostEv.id,
        eventType: lostEv.eventType, occurredAt: lostEv.occurredAt,
      });
      result.lost++;
      continue;
    }

    if (decision.kind === "won") {
      const m = decision.match;
      const carrierId = await findOrCreateCarrier(opp.organizationId, m.carrierName);
      await db.update(quoteOpportunities)
        .set({
          outcomeStatus: decision.lowMargin ? "won_low_margin" : "won",
          carrierId,
          carrierPaid: decision.cost > 0 ? String(decision.cost) : null,
          quotedAmount: opp.quotedAmount ?? (decision.revenue > 0 ? String(decision.revenue) : null),
        })
        .where(eq(quoteOpportunities.id, opp.id));
      const [wonEv] = await db.insert(quoteEvents).values({
        quoteId: opp.id,
        eventType: "tms_won",
        occurredAt: new Date(),
        actor: "TMS",
        payload: {
          orderId: m.orderId,
          carrierName: m.carrierName,
          revenue: m.revenue,
          cost: m.cost,
          margin: m.margin,
        },
      }).returning();
      await logQuoteTouchpointFromEvent({
        orgId: opp.organizationId, oppId: opp.id, eventId: wonEv.id,
        eventType: wonEv.eventType, occurredAt: wonEv.occurredAt,
      });
      result.won++;
      continue;
    }

    if (decision.kind === "expired") {
      await db.update(quoteOpportunities)
        .set({ outcomeStatus: "expired" })
        .where(eq(quoteOpportunities.id, opp.id));
      await db.insert(quoteEvents).values({
        quoteId: opp.id,
        eventType: "tms_expired",
        occurredAt: new Date(),
        actor: "TMS",
        payload: { reason: "validThrough passed without TMS match" },
      });
      result.expired++;
      continue;
    }

    result.unchanged++;
  }

  return result;
}

