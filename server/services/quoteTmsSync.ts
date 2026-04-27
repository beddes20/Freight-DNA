/**
 * TMS → Quote Outcome Sync (Task #470 / extended in Task #723)
 *
 * Pending quote opportunities sit in the dashboard until either the rep marks
 * them won/lost or the TMS confirms what actually happened. This service walks
 * pending/active quotes for an org and reconciles them against `load_fact`
 * rows imported from the TMS:
 *
 *   - Match by `sourceReference == load_fact.order_id` (preferred — the rep's
 *     reply usually quotes the TMS order number) OR by best-effort
 *     customer + lane + pickup-date proximity (default 14 days, env-tunable).
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
 *
 * Task #723 additions:
 *   - Alias-tolerant customer matching (case + punctuation + Inc/LLC/Co/etc).
 *   - City normalization (Saint↔St, "St." vs "St", whitespace).
 *   - Configurable date-window tolerance via `QUOTE_TMS_MATCH_WINDOW_DAYS`
 *     (defaults to 14, falls back to 14 on bad values).
 *   - "Probable match" tier: lane+customer match where pickup is within
 *     window but only by alias/normalized name. These do NOT auto-flip the
 *     quote — they surface in the diagnostics panel as suggestions so a rep
 *     can confirm or dismiss.
 *   - Per-org last-sync stats (scanned/exact/probable/no-match/won/lost/
 *     expired/unchanged + a small list of probable candidates) exposed via
 *     `getLastSyncStats(orgId)` for the diagnostics endpoint.
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
const DEFAULT_MATCH_WINDOW_DAYS = 14;

/**
 * Resolve the pickup-vs-request match window. Reads `QUOTE_TMS_MATCH_WINDOW_DAYS`
 * once per call (cheap; env reads are constant-time) so an ops bump can take
 * effect without a deploy. Falls back to the default on missing or invalid
 * values; a caller-supplied override always wins (used by tests).
 */
export function resolveMatchWindowMs(overrideDays?: number): number {
  if (typeof overrideDays === "number" && isFinite(overrideDays) && overrideDays > 0) {
    return overrideDays * DAY_MS;
  }
  const raw = process.env.QUOTE_TMS_MATCH_WINDOW_DAYS;
  if (raw) {
    const n = Number(raw);
    if (isFinite(n) && n > 0) return n * DAY_MS;
  }
  return DEFAULT_MATCH_WINDOW_DAYS * DAY_MS;
}

export interface SyncResult {
  scanned: number;
  won: number;
  lost: number;
  expired: number;
  unchanged: number;
  /** Quotes with a probable (alias/loose) TMS match that did NOT auto-flip. */
  probable: number;
}

function num(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Number(v); return isFinite(n) ? n : 0;
}

/**
 * Normalize a city name for fuzzy comparison. Handles common TMS / email
 * mismatches: "Saint Louis" vs "St. Louis", trailing punctuation, double
 * spaces, casing. Used for both origin and destination.
 */
export function normalizeCity(s: string | null | undefined): string {
  if (!s) return "";
  let v = s.toLowerCase().trim();
  // Saint ↔ St. ↔ St — collapse all variants to "st".
  v = v.replace(/\bsaint\b/g, "st");
  v = v.replace(/\bst\.\s+/g, "st ");
  // Strip remaining punctuation (commas, periods, dashes inside names).
  v = v.replace(/[.,;]/g, " ");
  // Collapse runs of whitespace.
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

/**
 * Normalize a state code (case-insensitive, trimmed). Doesn't expand full
 * names → codes because both TMS and quote inputs already use 2-letter codes.
 */
export function normalizeState(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/**
 * Normalize a customer name for alias-tolerant comparison: strip case,
 * legal suffixes (Inc/LLC/Co/Corp/Ltd/Company/Group/Holdings), trailing
 * "the", punctuation, and collapse whitespace.
 */
export function normalizeCustomerName(s: string | null | undefined): string {
  if (!s) return "";
  let v = s.toLowerCase();
  v = v.replace(/[.,'"&/\\-]/g, " ");
  v = v.replace(/\b(the)\b/g, " ");
  v = v.replace(/\b(inc|llc|l\.l\.c|co|corp|corporation|ltd|limited|company|group|holdings|holding|enterprises|industries|international)\b/g, " ");
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

function laneEquals(opp: QuoteOpportunity, fact: LoadFact): boolean {
  const factOrigin = `${normalizeCity(fact.originCity)}|${normalizeState(fact.originState)}`;
  const factDest = `${normalizeCity(fact.destinationCity)}|${normalizeState(fact.destinationState)}`;
  const oppOrigin = `${normalizeCity(opp.originCity)}|${normalizeState(opp.originState)}`;
  const oppDest = `${normalizeCity(opp.destCity)}|${normalizeState(opp.destState)}`;
  return factOrigin === oppOrigin && factDest === oppDest;
}

/**
 * Customer name match. Returns:
 *   - "exact": case/whitespace-insensitive equality
 *   - "alias": equal after stripping legal suffixes / punctuation
 *   - "none":  no relationship
 */
export function customerMatchTier(
  custName: string,
  fact: LoadFact,
): "exact" | "alias" | "none" {
  const factName = (fact.customerName ?? "").toLowerCase().trim();
  if (!factName) return "none";
  const c = custName.toLowerCase().trim();
  if (factName === c) return "exact";
  const a = normalizeCustomerName(factName);
  const b = normalizeCustomerName(c);
  if (a && b && a === b) return "alias";
  return "none";
}

export type SyncDecision =
  | { kind: "won"; match: LoadFact; lowMargin: boolean; cost: number; revenue: number; matchTier: "exact" | "alias" }
  | { kind: "lost"; match: LoadFact; matchTier: "exact" | "alias" }
  | { kind: "expired" }
  | { kind: "probable"; match: LoadFact; reason: string }
  | { kind: "unchanged" };

/**
 * Pure decision function — exposed for unit testing. Decides what action to
 * take for a single quote opportunity given the candidate TMS facts.
 *
 * Tiering:
 *   1. orderId reference → strongest signal, auto-flip.
 *   2. exact customer+lane+date → auto-flip.
 *   3. alias customer+lane+date → auto-flip (still tight enough that a
 *      legal-suffix mismatch shouldn't block a booked load from closing).
 *   4. exact customer+lane but pickup outside the configured window →
 *      "probable" — surface as a candidate, do NOT flip.
 *   5. alias customer+lane outside window → also "probable".
 *   6. No matching customer or lane → unchanged (or expired if past valid_through).
 */
export function decideSyncAction(
  opp: QuoteOpportunity,
  customerName: string,
  facts: LoadFact[],
  now: number,
  opts?: { matchWindowDays?: number },
): SyncDecision {
  const windowMs = resolveMatchWindowMs(opts?.matchWindowDays);

  // 1. Strongest: orderId reference match.
  let match: LoadFact | undefined;
  let matchTier: "exact" | "alias" = "exact";
  if (opp.sourceReference) {
    const ref = opp.sourceReference.toLowerCase();
    match = facts.find(f => (f.orderId ?? "").toLowerCase() === ref);
  }

  // 2/3. Lane + customer + date-window match. Try exact tier first so the
  // resulting decision carries the strongest signal we found.
  if (!match) {
    const exact = facts.find(f =>
      customerMatchTier(customerName, f) === "exact"
        && laneEquals(opp, f)
        && pickupNear(opp, f, windowMs),
    );
    if (exact) {
      match = exact;
      matchTier = "exact";
    } else {
      const alias = facts.find(f =>
        customerMatchTier(customerName, f) === "alias"
          && laneEquals(opp, f)
          && pickupNear(opp, f, windowMs),
      );
      if (alias) {
        match = alias;
        matchTier = "alias";
      }
    }
  }

  if (match && match.bucket === "cancelled") {
    return { kind: "lost", match, matchTier };
  }
  if (match && match.bucket === "realized") {
    // pg-node returns NUMERIC columns as strings; cast explicitly for the num() helper.
    const cost = num(match.cost != null ? String(match.cost) : null);
    const revenue = num(match.revenue != null ? String(match.revenue) : null);
    const quoted = num(opp.quotedAmount) || revenue;
    const margin = quoted - cost;
    const lowMargin = quoted > 0 && margin > 0 && margin / quoted < 0.06;
    return { kind: "won", match, lowMargin, cost, revenue, matchTier };
  }

  // Task #723 — if we found a strong match in steps 1–3 but the TMS bucket
  // isn't realized or cancelled (it's still active/available, or some
  // unexpected status), surface it as "probable" instead of dropping it on
  // the floor. The diagnostics panel uses these candidates to explain why a
  // pending quote hasn't flipped yet.
  if (match) {
    return { kind: "probable", match, reason: "still-active-in-tms" };
  }

  // 4/5. Probable match: same customer+lane but outside the configured
  // window. We deliberately skip the orderId-only path here because that
  // would already have matched above.
  if (!match) {
    const probable = facts.find(f =>
      customerMatchTier(customerName, f) !== "none" && laneEquals(opp, f),
    );
    if (probable) {
      const tier = customerMatchTier(customerName, probable);
      const reason = !pickupNear(opp, probable, windowMs)
        ? "outside-date-window"
        : (probable.bucket === "active" || probable.bucket === "available")
          ? "still-active-in-tms"
          : `${tier}-customer-match`;
      return { kind: "probable", match: probable, reason };
    }
  }

  if (opp.validThrough && opp.validThrough.getTime() < now) {
    return { kind: "expired" };
  }
  return { kind: "unchanged" };
}

function pickupNear(opp: QuoteOpportunity, fact: LoadFact, windowMs: number): boolean {
  if (!fact.pickupDate) return true; // can't enforce — accept
  const t = Date.parse(fact.pickupDate);
  if (!isFinite(t)) return true;
  return Math.abs(t - opp.requestDate.getTime()) <= windowMs;
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

// ─── Per-org sync stats (Task #723 diagnostics) ──────────────────────────────

export interface ProbableCandidate {
  quoteId: string;
  customerName: string;
  lane: string;
  requestDate: string; // ISO
  factOrderId: string | null;
  factCustomerName: string | null;
  factPickupDate: string | null;
  factBucket: string;
  reason: string;
}

export interface SyncStats {
  ranAt: string; // ISO
  scanned: number;
  exactMatches: number;
  aliasMatches: number;
  probable: number;
  noMatch: number;
  won: number;
  lost: number;
  expired: number;
  unchanged: number;
  /** Up to 25 probable candidates surfaced for the diagnostics panel. */
  probableCandidates: ProbableCandidate[];
}

const lastSyncStats = new Map<string, SyncStats>();

export function getLastSyncStats(orgId: string): SyncStats | null {
  return lastSyncStats.get(orgId) ?? null;
}

/** Test helper — clears the in-memory stats so tests don't bleed into one another. */
export function _resetSyncStatsForTest(): void {
  lastSyncStats.clear();
}

/**
 * Reconcile pending quote opportunities for an org against the TMS load_fact
 * table. Safe to run on a schedule (idempotent + bounded).
 */
export async function syncQuoteOutcomesFromTms(orgId: string): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, won: 0, lost: 0, expired: 0, unchanged: 0, probable: 0 };
  const probableCandidates: ProbableCandidate[] = [];
  let exactMatches = 0;
  let aliasMatches = 0;
  let noMatch = 0;

  const opps = await db.select().from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    // Drizzle's inArray expects the literal union column type; widening to string[]
    // is safe because ACTIVE_OUTCOMES only contains valid outcomeStatus literals.
    inArray(quoteOpportunities.outcomeStatus, ACTIVE_OUTCOMES as unknown as string[]),
  ));
  if (opps.length === 0) {
    const stats: SyncStats = {
      ranAt: new Date().toISOString(),
      scanned: 0, exactMatches: 0, aliasMatches: 0, probable: 0, noMatch: 0,
      won: 0, lost: 0, expired: 0, unchanged: 0,
      probableCandidates: [],
    };
    lastSyncStats.set(orgId, stats);
    return result;
  }
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
    if (!cust) { result.unchanged++; noMatch++; continue; }

    const decision = decideSyncAction(opp, cust.name, facts, now);

    if (decision.kind === "lost") {
      if (decision.matchTier === "exact") exactMatches++; else aliasMatches++;
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
          matchTier: decision.matchTier,
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
      if (decision.matchTier === "exact") exactMatches++; else aliasMatches++;
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
          matchTier: decision.matchTier,
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
      noMatch++;
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

    if (decision.kind === "probable") {
      result.probable++;
      result.unchanged++;
      if (probableCandidates.length < 25) {
        probableCandidates.push({
          quoteId: opp.id,
          customerName: cust.name,
          lane: `${opp.originCity}, ${opp.originState} → ${opp.destCity}, ${opp.destState}`,
          requestDate: opp.requestDate.toISOString(),
          factOrderId: decision.match.orderId ?? null,
          factCustomerName: decision.match.customerName ?? null,
          factPickupDate: decision.match.pickupDate ?? null,
          factBucket: decision.match.bucket,
          reason: decision.reason,
        });
      }
      continue;
    }

    noMatch++;
    result.unchanged++;
  }

  const stats: SyncStats = {
    ranAt: new Date().toISOString(),
    scanned: result.scanned,
    exactMatches,
    aliasMatches,
    probable: result.probable,
    noMatch,
    won: result.won,
    lost: result.lost,
    expired: result.expired,
    unchanged: result.unchanged,
    probableCandidates,
  };
  lastSyncStats.set(orgId, stats);

  return result;
}
