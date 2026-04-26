/**
 * Stale Quote Follow-Up service (Task #480).
 *
 * Surfaces pending quotes that have aged past the customer's typical
 * decision window. Per-customer windows are computed from the historical
 * gap between requestDate and the first decisive event (won / lost /
 * expired) in `quote_events`. We use a conservative p75 of that gap and
 * clamp it between a 24h floor and a 14-day ceiling. When a customer has
 * fewer than 4 decided quotes we fall back to a 72h default.
 *
 * Results are ranked by an estimated margin × age score so the highest-
 * impact follow-ups bubble to the top.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteOpportunities, quoteEvents, quoteCustomers, quoteReps,
  type QuoteOpportunity, type QuoteCustomer, type QuoteRep,
} from "@shared/schema";
import { publish as publishLiveSync } from "./liveSync";

const FLOOR_HOURS = 24;
const CEILING_HOURS = 14 * 24;
const DEFAULT_WINDOW_HOURS = 72;
const MIN_SAMPLES_FOR_HISTORY = 4;
const MARGIN_PROXY_PCT = 0.10;

export type CustomerDecisionWindow = {
  customerId: string;
  sampleSize: number;
  pTypicalHours: number;  // clamped, ready to compare
  rawP75Hours: number | null;
};

export type StaleQuoteFollowUp = {
  quoteId: string;
  customerId: string;
  customerName: string;
  repId: string | null;
  repName: string | null;
  repEmail: string | null;
  repUserId: string | null;
  lane: string;
  origin: string;
  destination: string;
  equipment: string;
  ageHours: number;
  pTypicalHours: number;
  hoursOverdue: number;
  quotedAmount: number;
  estimatedMargin: number;
  rankScore: number;
  requestDate: string;
};

type CacheEntry = { ts: number; result: StaleQuoteFollowUp[] };
const cache = new Map<string, CacheEntry>();
// 60s TTL — short enough that the sidebar badge poll picks up newly-stale
// quotes within ~90s and that decided quotes drop off the badge promptly,
// long enough that repeated badge polls from multiple open tabs are cheap.
const TTL_MS = 60 * 1000;

// Per-org snapshot of the last published stale-quote ID set. Used to detect
// membership transitions (a quote entering or exiting the stale window)
// between recomputes so we can fire a `customer_quote_followup` SSE event
// only when something actually changed — avoiding noisy empty broadcasts.
const lastPublishedIds = new Map<string, Set<string>>();

export function clearStaleFollowUpCache(orgId?: string): void {
  if (orgId) {
    cache.delete(orgId);
    // Also drop the per-org membership snapshot so the next recompute is
    // free to re-publish without the prior snapshot suppressing it. This
    // keeps the map from growing unbounded over a long-lived process that
    // sees many transient orgs (e.g. test orgs, deactivated tenants).
    lastPublishedIds.delete(orgId);
  } else {
    cache.clear();
    lastPublishedIds.clear();
  }
}

const num = (v: string | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};

const isDecisive = (status: string): boolean =>
  status === "won" || status === "won_low_margin" ||
  status.startsWith("lost_") || status === "no_response" || status === "expired";

const clamp = (h: number): number => Math.max(FLOOR_HOURS, Math.min(CEILING_HOURS, h));

function p75(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.75);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export async function computeCustomerWindows(orgId: string): Promise<Map<string, CustomerDecisionWindow>> {
  const decided = await db.select().from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      sql`${quoteOpportunities.outcomeStatus} != 'pending'`,
    ));

  const byCustomer = new Map<string, number[]>();
  if (decided.length > 0) {
    const ids = decided.map(d => d.id);
    const events = await db.select().from(quoteEvents)
      .where(inArray(quoteEvents.quoteId, ids));
    const decisiveEventByQuote = new Map<string, Date>();
    for (const ev of events) {
      const t = ev.eventType;
      if (t === "won" || t === "lost" || t === "expired" || t === "no_response" || t === "decided") {
        const prev = decisiveEventByQuote.get(ev.quoteId);
        if (!prev || ev.occurredAt < prev) {
          decisiveEventByQuote.set(ev.quoteId, ev.occurredAt);
        }
      }
    }
    for (const opp of decided) {
      if (!isDecisive(opp.outcomeStatus)) continue;
      const decidedAt = decisiveEventByQuote.get(opp.id);
      if (!decidedAt) continue;
      const hours = (decidedAt.getTime() - opp.requestDate.getTime()) / 3_600_000;
      if (!isFinite(hours) || hours <= 0) continue;
      const arr = byCustomer.get(opp.customerId) ?? [];
      arr.push(hours);
      byCustomer.set(opp.customerId, arr);
    }
  }

  const windows = new Map<string, CustomerDecisionWindow>();
  for (const [customerId, arr] of byCustomer.entries()) {
    if (arr.length < MIN_SAMPLES_FOR_HISTORY) {
      windows.set(customerId, {
        customerId, sampleSize: arr.length, rawP75Hours: arr.length ? p75(arr) : null,
        pTypicalHours: DEFAULT_WINDOW_HOURS,
      });
    } else {
      const raw = p75(arr);
      windows.set(customerId, {
        customerId, sampleSize: arr.length, rawP75Hours: raw, pTypicalHours: clamp(raw),
      });
    }
  }
  return windows;
}

export async function getStaleQuoteFollowUps(
  orgId: string,
  opts: { force?: boolean } = {},
): Promise<StaleQuoteFollowUp[]> {
  const hit = cache.get(orgId);
  if (!opts.force && hit && Date.now() - hit.ts < TTL_MS) return hit.result;

  const [pending, customers, reps, windows] = await Promise.all([
    db.select().from(quoteOpportunities).where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.outcomeStatus, "pending"),
    )),
    db.select().from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)),
    db.select().from(quoteReps).where(eq(quoteReps.organizationId, orgId)),
    computeCustomerWindows(orgId),
  ]);

  const customerMap = new Map<string, QuoteCustomer>(customers.map(c => [c.id, c]));
  const repMap = new Map<string, QuoteRep>(reps.map(r => [r.id, r]));
  const now = Date.now();

  const items: StaleQuoteFollowUp[] = [];
  for (const opp of pending as QuoteOpportunity[]) {
    const cust = customerMap.get(opp.customerId);
    if (!cust) continue;
    const win = windows.get(opp.customerId)?.pTypicalHours ?? DEFAULT_WINDOW_HOURS;
    const ageHours = (now - opp.requestDate.getTime()) / 3_600_000;
    if (ageHours <= win) continue;

    const rep = opp.repId ? repMap.get(opp.repId) ?? null : null;
    const quoted = num(opp.quotedAmount);
    const margin = quoted * MARGIN_PROXY_PCT;
    const hoursOverdue = ageHours - win;

    items.push({
      quoteId: opp.id,
      customerId: opp.customerId,
      customerName: cust.name,
      repId: opp.repId,
      repName: rep?.name ?? null,
      repEmail: rep?.email ?? null,
      repUserId: rep?.userId ?? null,
      lane: `${opp.originCity}, ${opp.originState} → ${opp.destCity}, ${opp.destState}`,
      origin: `${opp.originCity}, ${opp.originState}`,
      destination: `${opp.destCity}, ${opp.destState}`,
      equipment: opp.equipment,
      ageHours,
      pTypicalHours: win,
      hoursOverdue,
      quotedAmount: quoted,
      estimatedMargin: margin,
      rankScore: margin * Math.max(1, hoursOverdue),
      requestDate: opp.requestDate.toISOString(),
    });
  }

  items.sort((a, b) => b.rankScore - a.rankScore);
  cache.set(orgId, { ts: Date.now(), result: items });

  // Membership-transition detection: if the set of stale-quote IDs differs
  // from the previous broadcast, fire a `customer_quote_followup` SSE event
  // so open clients (sidebar badge, Customer Quotes page) refresh. This
  // covers both passive transitions (a quote ages into the window between
  // recomputes) and explicit ones (a quote was decided and dropped off).
  // First-time recompute always publishes so initial sidebar mounts pick up
  // the count without waiting for a transition.
  try {
    const newIds = new Set(items.map(i => i.quoteId));
    const prev = lastPublishedIds.get(orgId);
    const changed = !prev
      || prev.size !== newIds.size
      || [...newIds].some(id => !prev.has(id));
    if (changed) {
      lastPublishedIds.set(orgId, newIds);
      publishLiveSync(orgId, "customer_quote_followup");
    }
  } catch {
    // Pub/sub is advisory only — never let a publish error fail the caller.
  }

  return items;
}

/**
 * Lightweight count helper for the sidebar badge. Reuses the same per-org
 * cache as `getStaleQuoteFollowUps`, so a badge poll either hits the warm
 * cached list (cheap) or triggers exactly one shared recompute that the
 * full Customer Quotes page can also consume.
 */
export async function getStaleQuoteFollowUpCount(
  orgId: string,
  opts: { force?: boolean } = {},
): Promise<number> {
  const items = await getStaleQuoteFollowUps(orgId, opts);
  return items.length;
}
