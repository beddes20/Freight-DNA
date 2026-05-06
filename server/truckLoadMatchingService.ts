/**
 * Truck-Load Matching Service (Task #844)
 *
 * Reverse-matches parsed truck postings against open freight_opportunities.
 *
 * Score components (0–100):
 *   - Origin proximity (0–60):  same city = 60, ≤25mi = 55, ≤75mi = 45,
 *                                ≤150mi = 30, ≤300mi = 15, same state = 10.
 *   - Date overlap (0–25):       same day = 25, ±1d = 18, ±3d = 12, ±7d = 6.
 *   - Equipment fit (0–15):      exact = 15, family = 10 (van+reefer cross-fit),
 *                                empty/unknown = 5.
 *   - Destination preference bonus (0–10): when carrier wants a region and the
 *                                load destination matches.
 *
 * Hooks:
 *   - matchPosting(posting):           run after a posting is inserted.
 *   - matchOpportunity(opportunity):   run after a freight opportunity is created
 *                                       (re-match all active postings).
 *   - rematchAllForOrg(orgId):          background sweep used by import endpoints.
 */

import { storage as defaultStorage, db } from "./storage";
import {
  type TruckPosting,
  type FreightOpportunity,
  type InsertTruckLoadMatch,
  type InsertNotification,
  freightOpportunities,
} from "@shared/schema";
import { geocodeCity, haversineDistance } from "./geocoding";
import { and, eq, sql } from "drizzle-orm";

export const STRONG_MATCH_THRESHOLD = 75;
export const MIN_MATCH_THRESHOLD = 35;

const VAN_FAMILY = new Set(["van", "dry van"]);
const REEFER_FAMILY = new Set(["reefer", "refrigerated"]);
const FLAT_FAMILY = new Set(["flatbed", "step deck", "stepdeck", "rgn", "lowboy", "conestoga"]);

function eqFamily(t: string): Set<string> | null {
  const s = t.toLowerCase().trim();
  if (VAN_FAMILY.has(s)) return VAN_FAMILY;
  if (REEFER_FAMILY.has(s)) return REEFER_FAMILY;
  if (FLAT_FAMILY.has(s)) return FLAT_FAMILY;
  return null;
}

function originDistanceMiles(posting: TruckPosting, opp: FreightOpportunity): number | null {
  const pCity = posting.originCity ?? null;
  const pState = posting.originState ?? null;
  const oCity = opp.origin ?? null;
  const oState = opp.originState ?? null;
  if (!pCity && !pState) return null;
  if (!oCity && !oState) return null;
  if (pCity && oCity && pState && oState) {
    if (pCity.toLowerCase().trim() === oCity.toLowerCase().trim() && pState === oState) return 0;
    const a = geocodeCity(pCity, pState);
    const b = geocodeCity(oCity, oState);
    if (a && b) return haversineDistance(a[0], a[1], b[0], b[1]);
  }
  if (pState && oState && pState === oState) return 100; // approximate same-state
  return null;
}

function dayDelta(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

export type FitResult = { score: number; reasons: string[] };

export function scoreFit(posting: TruckPosting, opp: FreightOpportunity): FitResult {
  const reasons: string[] = [];
  let score = 0;

  // ── Origin proximity ──
  const dist = originDistanceMiles(posting, opp);
  let originPts = 0;
  if (dist === 0) { originPts = 60; reasons.push(`Same origin city (${opp.origin}, ${opp.originState ?? ""})`); }
  else if (dist !== null && dist <= 25) { originPts = 55; reasons.push(`Origin within 25 mi (${dist.toFixed(0)} mi)`); }
  else if (dist !== null && dist <= 75) { originPts = 45; reasons.push(`Origin within 75 mi (${dist.toFixed(0)} mi)`); }
  else if (dist !== null && dist <= 150) { originPts = 30; reasons.push(`Origin within 150 mi (${dist.toFixed(0)} mi)`); }
  else if (dist !== null && dist <= 300) { originPts = 15; reasons.push(`Origin within 300 mi (${dist.toFixed(0)} mi)`); }
  else if (posting.originState && opp.originState && posting.originState === opp.originState) {
    originPts = 10;
    reasons.push(`Same origin state (${opp.originState})`);
  }
  score += originPts;

  // ── Date overlap ──
  const oppDate = (opp.pickupWindowStart ?? "").slice(0, 10) || null;
  const inWindow = (() => {
    if (!posting.availableDate || !oppDate) return null;
    const start = posting.availableDate;
    const end = posting.availableThrough ?? posting.availableDate;
    if (oppDate >= start && oppDate <= end) return 0;
    return null;
  })();
  let datePts = 0;
  if (inWindow === 0) {
    datePts = 25;
    reasons.push(`Pickup ${oppDate} inside available window`);
  } else {
    const delta = dayDelta(posting.availableDate, oppDate);
    if (delta !== null) {
      if (delta <= 1) { datePts = 18; reasons.push(`Pickup within 1 day of available`); }
      else if (delta <= 3) { datePts = 12; reasons.push(`Pickup within 3 days of available`); }
      else if (delta <= 7) { datePts = 6; reasons.push(`Pickup within 7 days of available`); }
    }
  }
  score += datePts;

  // ── Equipment fit ──
  const pe = (posting.equipment ?? "").toLowerCase().trim();
  const oe = (opp.equipmentType ?? "").toLowerCase().trim();
  let eqPts = 0;
  if (!pe || !oe) {
    eqPts = 5;
  } else if (pe === oe) {
    eqPts = 15;
    reasons.push(`Equipment match (${opp.equipmentType})`);
  } else {
    const pf = eqFamily(pe);
    const of = eqFamily(oe);
    if (pf && of && pf === of) {
      eqPts = 10;
      reasons.push(`Equipment family match (${posting.equipment} ↔ ${opp.equipmentType})`);
    }
  }
  score += eqPts;

  // ── Destination preference bonus ──
  const dPref = (posting.destPreference ?? posting.destState ?? posting.destCity ?? "").toLowerCase();
  const oDest = `${opp.destination ?? ""} ${opp.destinationState ?? ""}`.toLowerCase();
  if (dPref && oDest && (oDest.includes(dPref) || (posting.destState && opp.destinationState === posting.destState))) {
    score += 10;
    reasons.push(`Destination matches carrier preference`);
  }

  return { score: Math.min(100, Math.max(0, Math.round(score))), reasons };
}

/**
 * Resolve the rep this match should notify. Prefer the freight opportunity's
 * delegated rep, then owner, then creator.
 */
function resolveAssignedRep(opp: FreightOpportunity): string | null {
  return opp.delegatedToUserId ?? opp.ownerUserId ?? opp.createdById ?? null;
}

async function listOpenFreightForOrg(orgId: string): Promise<FreightOpportunity[]> {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(freightOpportunities)
    .where(
      and(
        eq(freightOpportunities.orgId, orgId),
        // Only "live" rows: not won/lost/closed/expired
      ),
    )
    .then(rows => rows.filter(r => {
      const status = (r.status ?? "").toLowerCase();
      if (["won", "lost", "closed", "cancelled", "expired"].includes(status)) return false;
      // exclude past pickup
      if (r.pickupWindowEnd && r.pickupWindowEnd.slice(0, 10) < today) return false;
      return true;
    }));
}

export type MatchRunResult = {
  postingsConsidered: number;
  oppsConsidered: number;
  matchesUpserted: number;
  notificationsSent: number;
};

async function persistMatchesForPosting(
  posting: TruckPosting,
  opps: FreightOpportunity[],
  storage: typeof defaultStorage,
  notify: boolean,
): Promise<{ upserted: number; notified: number }> {
  let upserted = 0;
  let notified = 0;
  for (const opp of opps) {
    const fit = scoreFit(posting, opp);
    if (fit.score < MIN_MATCH_THRESHOLD) continue;
    const data: InsertTruckLoadMatch = {
      orgId: posting.orgId,
      truckPostingId: posting.id,
      freightOpportunityId: opp.id,
      fitScore: fit.score,
      reasons: fit.reasons,
      assignedRepId: resolveAssignedRep(opp),
      state: "new",
    };
    const match = await storage.upsertTruckLoadMatch(data);
    upserted += 1;

    if (notify && fit.score >= STRONG_MATCH_THRESHOLD && !match.notifiedAt && match.assignedRepId) {
      try {
        const carrierLabel = posting.carrierNameRaw ?? "Carrier";
        const titleLane = `${posting.originCity ?? posting.originState ?? "?"}` +
          (posting.destCity || posting.destState ? ` → ${posting.destCity ?? posting.destState}` : "");
        const notif: InsertNotification = {
          userId: match.assignedRepId,
          type: "capacity_match",
          title: `Carrier capacity match (${fit.score}) — ${carrierLabel}`,
          body: `${titleLane} fits load ${opp.origin} → ${opp.destination}`,
          link: `/available-freight/capacity-matches?match=${match.id}`,
          relatedId: match.id,
        };
        const already = await storage.hasUnreadNotification(match.assignedRepId, "capacity_match", match.id);
        if (!already) {
          await storage.createNotification(notif);
          notified += 1;
        }
        await storage.markTruckLoadMatchNotified(match.id);
      } catch (err) {
        console.error("[truckLoadMatching] notify failed:", err);
      }
    }
  }
  return { upserted, notified };
}

/**
 * Match a batch of postings (typically one inbound email's truck list) against
 * open freight, then coalesce per-rep STRONG matches into ONE summary
 * notification per rep. Avoids spamming when a single email contains 30+ rows.
 */
export async function matchPostingsBatch(
  postings: TruckPosting[],
  opts: { notify?: boolean; storage?: typeof defaultStorage; source?: string } = {},
): Promise<MatchRunResult> {
  const storage = opts.storage ?? defaultStorage;
  if (postings.length === 0) {
    return { postingsConsidered: 0, oppsConsidered: 0, matchesUpserted: 0, notificationsSent: 0 };
  }
  const orgId = postings[0].orgId;
  const opps = await listOpenFreightForOrg(orgId);
  let upserted = 0;
  // Collect strong matches per rep without triggering individual notifications.
  const strongByRep = new Map<string, Array<{ matchId: string; score: number; opp: FreightOpportunity }>>();
  for (const posting of postings) {
    const r = await persistMatchesForPosting(posting, opps, storage, false);
    upserted += r.upserted;
    if (!opts.notify) continue;
    const matchesForPosting = await storage.listTruckLoadMatchesByPosting(posting.id);
    for (const m of matchesForPosting) {
      if (m.fitScore < STRONG_MATCH_THRESHOLD || !m.assignedRepId || m.notifiedAt) continue;
      const opp = opps.find(o => o.id === m.freightOpportunityId);
      if (!opp) continue;
      const list = strongByRep.get(m.assignedRepId) ?? [];
      list.push({ matchId: m.id, score: m.fitScore, opp });
      strongByRep.set(m.assignedRepId, list);
    }
  }

  let notified = 0;
  if (opts.notify) {
    for (const [repId, list] of strongByRep) {
      try {
        const top = list.sort((a, b) => b.score - a.score).slice(0, 3);
        const carrierLabel = postings[0].carrierNameRaw ?? "a carrier";
        const title = list.length === 1
          ? `Carrier capacity match (${top[0].score})`
          : `${list.length} carrier capacity matches`;
        const lanes = top.map(x => `${x.opp.origin} → ${x.opp.destination} (${x.score})`).join("; ");
        const link = list.length === 1
          ? `/available-freight/capacity-matches?match=${list[0].matchId}`
          : `/available-freight/capacity-matches`;
        // Coalesce: dedupe per rep by relatedId = first match id of the batch.
        const dedupeKey = list[0].matchId;
        const already = await storage.hasUnreadNotification(repId, "capacity_match", dedupeKey);
        if (!already) {
          await storage.createNotification({
            userId: repId,
            type: "capacity_match",
            title,
            body: `From ${carrierLabel}: ${lanes}${list.length > 3 ? ` and ${list.length - 3} more` : ""}`,
            link,
            relatedId: dedupeKey,
          });
          notified += 1;
        }
        for (const item of list) {
          await storage.markTruckLoadMatchNotified(item.matchId);
        }
      } catch (err) {
        console.error("[truckLoadMatching] batch notify failed:", err);
      }
    }
  }

  return { postingsConsidered: postings.length, oppsConsidered: opps.length, matchesUpserted: upserted, notificationsSent: notified };
}

/**
 * Match a single newly-inserted posting against all open opportunities.
 */
export async function matchPosting(
  posting: TruckPosting,
  opts: { notify?: boolean; storage?: typeof defaultStorage } = {},
): Promise<MatchRunResult> {
  const storage = opts.storage ?? defaultStorage;
  const opps = await listOpenFreightForOrg(posting.orgId);
  const { upserted, notified } = await persistMatchesForPosting(posting, opps, storage, opts.notify ?? true);
  return { postingsConsidered: 1, oppsConsidered: opps.length, matchesUpserted: upserted, notificationsSent: notified };
}

/**
 * Re-match all active postings against a freshly created opportunity. Used by
 * the daily-import hook so newly imported freight immediately surfaces against
 * still-active carrier capacity.
 */
export async function matchOpportunity(
  opp: FreightOpportunity,
  opts: { notify?: boolean; storage?: typeof defaultStorage } = {},
): Promise<MatchRunResult> {
  const storage = opts.storage ?? defaultStorage;
  const postings = await storage.listActiveTruckPostingsByOrg(opp.orgId);
  let upserted = 0;
  let notified = 0;
  for (const posting of postings) {
    const r = await persistMatchesForPosting(posting, [opp], storage, opts.notify ?? true);
    upserted += r.upserted;
    notified += r.notified;
  }
  return { postingsConsidered: postings.length, oppsConsidered: 1, matchesUpserted: upserted, notificationsSent: notified };
}

/**
 * Org-wide rematch — used by manual admin endpoints + the daily import sweep.
 */
export async function rematchAllForOrg(
  orgId: string,
  opts: { notify?: boolean; storage?: typeof defaultStorage } = {},
): Promise<MatchRunResult> {
  const storage = opts.storage ?? defaultStorage;
  const postings = await storage.listActiveTruckPostingsByOrg(orgId);
  const opps = await listOpenFreightForOrg(orgId);
  let upserted = 0;
  let notified = 0;
  for (const posting of postings) {
    const r = await persistMatchesForPosting(posting, opps, storage, opts.notify ?? true);
    upserted += r.upserted;
    notified += r.notified;
  }
  return { postingsConsidered: postings.length, oppsConsidered: opps.length, matchesUpserted: upserted, notificationsSent: notified };
}

/**
 * Sweep stale matches whose underlying posting expired. Marks linked matches
 * (state=new) as state=stale so the UI can hide them by default.
 */
export async function markStaleMatches(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.execute(sql`
    UPDATE truck_load_matches m
    SET state = 'stale', updated_at = NOW()
    FROM truck_postings p
    WHERE m.truck_posting_id = p.id
      AND p.status <> 'active'
      AND m.state = 'new'
  `);
  return Number((result as { rowCount?: number | null })?.rowCount ?? 0);
}
