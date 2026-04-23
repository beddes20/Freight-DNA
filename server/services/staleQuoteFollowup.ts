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
const TTL_MS = 60 * 60 * 1000; // 1h

export function clearStaleFollowUpCache(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
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
  return items;
}
