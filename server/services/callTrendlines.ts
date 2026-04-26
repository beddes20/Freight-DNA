import { and, desc, eq, gte, sql, inArray } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import { touchpoints, nbaCards, contacts, companies, users } from "@shared/schema";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type CallDirection = "inbound" | "outbound";

export interface WeekBucket {
  weekStart: string; // ISO date (Monday)
  inbound: number;
  outbound: number;
  missed: number;
}

export interface RepBucket {
  repId: string;
  repName: string;
  inbound: number;
  outbound: number;
  missed: number;
  total: number;
}

export interface CompanyTrendline {
  companyId: string;
  totals: { inbound: number; outbound: number; missed: number; total: number };
  weeks: WeekBucket[];
  byRep: RepBucket[];
}

function startOfWeek(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = out.getUTCDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // distance back to Monday
  out.setUTCDate(out.getUTCDate() - offset);
  return out;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function detectDirection(notes: string | null | undefined): CallDirection | null {
  if (!notes) return null;
  if (/Inbound call/i.test(notes)) return "inbound";
  if (/Outbound call/i.test(notes)) return "outbound";
  return null;
}

function isWebexTouchpoint(notes: string | null | undefined): boolean {
  return !!notes && /\[Webex CDR:/.test(notes);
}

function buildEmptyWeeks(days: number, end: Date): WeekBucket[] {
  const weeks: WeekBucket[] = [];
  const last = startOfWeek(end);
  const earliest = startOfWeek(new Date(end.getTime() - days * 24 * 60 * 60 * 1000));
  for (let t = earliest.getTime(); t <= last.getTime(); t += WEEK_MS) {
    weeks.push({ weekStart: isoDay(new Date(t)), inbound: 0, outbound: 0, missed: 0 });
  }
  return weeks;
}

export async function buildCompanyCallTrendline(
  companyId: string,
  days: number,
  repId?: string,
): Promise<CompanyTrendline> {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const tpConds = [
    eq(touchpoints.companyId, companyId),
    eq(touchpoints.type, "call"),
    gte(touchpoints.date, sinceDay),
  ];
  if (repId) tpConds.push(eq(touchpoints.loggedById, repId));
  const cardConds = [
    eq(nbaCards.companyId, companyId),
    eq(nbaCards.ruleType, "webex_missed_call"),
    gte(nbaCards.createdAt, sinceIso),
  ];
  if (repId) cardConds.push(eq(nbaCards.userId, repId));

  const [tps, missedCards] = await Promise.all([
    db.select().from(touchpoints).where(and(...tpConds)),
    db.select().from(nbaCards).where(and(...cardConds)),
  ]);

  const weeks = buildEmptyWeeks(days, new Date());
  const weekIndex = new Map<string, number>();
  weeks.forEach((w, i) => weekIndex.set(w.weekStart, i));

  const byRepMap = new Map<string, RepBucket>();
  const ensureRep = (id: string) => {
    let r = byRepMap.get(id);
    if (!r) {
      r = { repId: id, repName: "", inbound: 0, outbound: 0, missed: 0, total: 0 };
      byRepMap.set(id, r);
    }
    return r;
  };

  let totalIn = 0, totalOut = 0, totalMissed = 0;

  for (const tp of tps) {
    if (!isWebexTouchpoint(tp.notes)) continue;
    const dir = detectDirection(tp.notes);
    if (!dir) continue;
    const wkKey = isoDay(startOfWeek(new Date(tp.date + "T00:00:00Z")));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    weeks[idx][dir]++;
    if (dir === "inbound") totalIn++; else totalOut++;
    const rep = ensureRep(tp.loggedById);
    rep[dir]++;
    rep.total++;
  }

  for (const card of missedCards) {
    const wkKey = isoDay(startOfWeek(new Date(card.createdAt)));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    weeks[idx].missed++;
    totalMissed++;
    const rep = ensureRep(card.userId);
    rep.missed++;
    rep.total++;
  }

  // Hydrate rep names
  const repIds = Array.from(byRepMap.keys());
  if (repIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, repIds));
    const nameMap = new Map(userRows.map(u => [u.id, u.name]));
    for (const r of byRepMap.values()) r.repName = nameMap.get(r.repId) || "Unknown";
  }

  return {
    companyId,
    totals: { inbound: totalIn, outbound: totalOut, missed: totalMissed, total: totalIn + totalOut + totalMissed },
    weeks,
    byRep: Array.from(byRepMap.values()).sort((a, b) => b.total - a.total),
  };
}

export interface OrgTrendline {
  totals: { inbound: number; outbound: number; missed: number; total: number };
  weeks: WeekBucket[];
  byRep: RepBucket[];
}

/**
 * Org-wide call trendline used by the Call Performance Hub (`/calls`). Mirrors
 * `buildCompanyCallTrendline` but scopes to every company in the org so a
 * single page can render team-level pace + per-rep breakdown for the picker
 * window. Optional `repId` narrows to a single rep across the whole org.
 */
export async function buildOrgCallTrendline(
  orgId: string,
  days: number,
  repId?: string,
): Promise<OrgTrendline> {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const orgCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.organizationId, orgId));
  if (orgCompanies.length === 0) {
    return {
      totals: { inbound: 0, outbound: 0, missed: 0, total: 0 },
      weeks: buildEmptyWeeks(days, new Date()),
      byRep: [],
    };
  }
  const companyIds = orgCompanies.map(c => c.id);

  const tpConds = [
    inArray(touchpoints.companyId, companyIds),
    eq(touchpoints.type, "call"),
    gte(touchpoints.date, sinceDay),
  ];
  if (repId) tpConds.push(eq(touchpoints.loggedById, repId));

  const cardConds = [
    eq(nbaCards.orgId, orgId),
    eq(nbaCards.ruleType, "webex_missed_call"),
    gte(nbaCards.createdAt, sinceIso),
  ];
  if (repId) cardConds.push(eq(nbaCards.userId, repId));

  const [tps, missedCards] = await Promise.all([
    db
      .select({
        loggedById: touchpoints.loggedById,
        date: touchpoints.date,
        notes: touchpoints.notes,
      })
      .from(touchpoints)
      .where(and(...tpConds)),
    db
      .select({
        userId: nbaCards.userId,
        createdAt: nbaCards.createdAt,
      })
      .from(nbaCards)
      .where(and(...cardConds)),
  ]);

  const weeks = buildEmptyWeeks(days, new Date());
  const weekIndex = new Map<string, number>();
  weeks.forEach((w, i) => weekIndex.set(w.weekStart, i));

  const byRepMap = new Map<string, RepBucket>();
  const ensureRep = (id: string) => {
    let r = byRepMap.get(id);
    if (!r) {
      r = { repId: id, repName: "", inbound: 0, outbound: 0, missed: 0, total: 0 };
      byRepMap.set(id, r);
    }
    return r;
  };

  let totalIn = 0, totalOut = 0, totalMissed = 0;

  for (const tp of tps) {
    if (!isWebexTouchpoint(tp.notes)) continue;
    const dir = detectDirection(tp.notes);
    if (!dir) continue;
    const wkKey = isoDay(startOfWeek(new Date(tp.date + "T00:00:00Z")));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    weeks[idx][dir]++;
    if (dir === "inbound") totalIn++; else totalOut++;
    const rep = ensureRep(tp.loggedById);
    rep[dir]++;
    rep.total++;
  }

  for (const card of missedCards) {
    const wkKey = isoDay(startOfWeek(new Date(card.createdAt)));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    weeks[idx].missed++;
    totalMissed++;
    const rep = ensureRep(card.userId);
    rep.missed++;
    rep.total++;
  }

  const repIds = Array.from(byRepMap.keys());
  if (repIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, repIds));
    const nameMap = new Map(userRows.map(u => [u.id, u.name]));
    for (const r of byRepMap.values()) r.repName = nameMap.get(r.repId) || "Unknown";
  }

  return {
    totals: { inbound: totalIn, outbound: totalOut, missed: totalMissed, total: totalIn + totalOut + totalMissed },
    weeks,
    byRep: Array.from(byRepMap.values()).sort((a, b) => b.total - a.total),
  };
}

export interface CallPaceRow {
  companyId: string;
  companyName: string;
  inbound: number;
  outbound: number;
  missed: number;
  total: number;
  sparkline: number[]; // counts per week (oldest → newest), all directions combined
}

export async function buildOrgCallPace(orgId: string, days: number): Promise<CallPaceRow[]> {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const orgCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.organizationId, orgId));
  if (orgCompanies.length === 0) return [];

  const companyIds = orgCompanies.map(c => c.id);

  const tps = await db
    .select({
      companyId: touchpoints.companyId,
      date: touchpoints.date,
      notes: touchpoints.notes,
    })
    .from(touchpoints)
    .where(
      and(
        inArray(touchpoints.companyId, companyIds),
        eq(touchpoints.type, "call"),
        gte(touchpoints.date, sinceDay),
      ),
    );

  const cards = await db
    .select({
      companyId: nbaCards.companyId,
      createdAt: nbaCards.createdAt,
    })
    .from(nbaCards)
    .where(
      and(
        eq(nbaCards.orgId, orgId),
        eq(nbaCards.ruleType, "webex_missed_call"),
        gte(nbaCards.createdAt, sinceIso),
      ),
    );

  const skeleton = buildEmptyWeeks(days, new Date());
  const weekIndex = new Map<string, number>();
  skeleton.forEach((w, i) => weekIndex.set(w.weekStart, i));
  const numWeeks = skeleton.length;

  type Agg = { inbound: number; outbound: number; missed: number; spark: number[] };
  const byCompany = new Map<string, Agg>();
  const ensure = (cid: string): Agg => {
    let a = byCompany.get(cid);
    if (!a) {
      a = { inbound: 0, outbound: 0, missed: 0, spark: new Array(numWeeks).fill(0) };
      byCompany.set(cid, a);
    }
    return a;
  };

  for (const tp of tps) {
    if (!tp.companyId) continue;
    if (!isWebexTouchpoint(tp.notes)) continue;
    const dir = detectDirection(tp.notes);
    if (!dir) continue;
    const wkKey = isoDay(startOfWeek(new Date(tp.date + "T00:00:00Z")));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    const a = ensure(tp.companyId);
    a[dir]++;
    a.spark[idx]++;
  }

  for (const card of cards) {
    if (!card.companyId) continue;
    const wkKey = isoDay(startOfWeek(new Date(card.createdAt)));
    const idx = weekIndex.get(wkKey);
    if (idx == null) continue;
    const a = ensure(card.companyId);
    a.missed++;
    a.spark[idx]++;
  }

  const nameMap = new Map(orgCompanies.map(c => [c.id, c.name]));
  const rows: CallPaceRow[] = [];
  for (const [cid, a] of byCompany.entries()) {
    const total = a.inbound + a.outbound + a.missed;
    if (total === 0) continue;
    rows.push({
      companyId: cid,
      companyName: nameMap.get(cid) || "Unknown",
      inbound: a.inbound,
      outbound: a.outbound,
      missed: a.missed,
      total,
      sparkline: a.spark,
    });
  }

  return rows.sort((a, b) => b.total - a.total);
}

export interface LaneRollupRow {
  companyId: string;
  companyName: string;
  contactCount: number;
  inbound: number;
  outbound: number;
  missed: number;
  total: number;
}

export interface LaneRollup {
  lane: string;
  days: number;
  rows: LaneRollupRow[];
  totals: { inbound: number; outbound: number; missed: number; total: number; companies: number; contacts: number };
}

export async function buildLaneCallRollup(orgId: string, lane: string, days: number): Promise<LaneRollup> {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const orgCompanies = await storage.getCompanies(orgId);
  const companyIds = orgCompanies.map(c => c.id);
  if (companyIds.length === 0) {
    return { lane, days, rows: [], totals: { inbound: 0, outbound: 0, missed: 0, total: 0, companies: 0, contacts: 0 } };
  }
  const allContacts = await storage.getContactsByCompanyIds(companyIds);
  const needle = lane.toLowerCase().trim();
  if (!needle) {
    return { lane, days, rows: [], totals: { inbound: 0, outbound: 0, missed: 0, total: 0, companies: 0, contacts: 0 } };
  }
  // Tolerant lane matching: split on common arrow separators and require both
  // sides to appear in a contact lane string (substring, case-insensitive).
  // Use tokenized separators so city names like "Toronto" don't split on "to".
  const arrowSplit = needle.split(/\s*(?:→|->|—|--|\bto\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const matchesLane = (laneStr: string): boolean => {
    const s = laneStr.toLowerCase();
    if (s.includes(needle)) return true;
    if (arrowSplit.length >= 2) {
      return arrowSplit.every(part => s.includes(part));
    }
    return false;
  };

  const matchedContacts = allContacts.filter(c => Array.isArray(c.lanes) && c.lanes.some(matchesLane));
  if (matchedContacts.length === 0) {
    return { lane, days, rows: [], totals: { inbound: 0, outbound: 0, missed: 0, total: 0, companies: 0, contacts: 0 } };
  }

  const contactIds = matchedContacts.map(c => c.id);
  const contactByCompany = new Map<string, Set<string>>();
  for (const c of matchedContacts) {
    if (!c.companyId) continue;
    let s = contactByCompany.get(c.companyId);
    if (!s) { s = new Set(); contactByCompany.set(c.companyId, s); }
    s.add(c.id);
  }

  const tps = await db
    .select({
      companyId: touchpoints.companyId,
      contactId: touchpoints.contactId,
      notes: touchpoints.notes,
      date: touchpoints.date,
    })
    .from(touchpoints)
    .where(
      and(
        inArray(touchpoints.contactId, contactIds),
        eq(touchpoints.type, "call"),
        gte(touchpoints.date, sinceDay),
      ),
    );

  const cards = await db
    .select({ companyId: nbaCards.companyId, contactId: nbaCards.contactId, createdAt: nbaCards.createdAt })
    .from(nbaCards)
    .where(
      and(
        eq(nbaCards.orgId, orgId),
        eq(nbaCards.ruleType, "webex_missed_call"),
        inArray(nbaCards.contactId, contactIds),
        gte(nbaCards.createdAt, sinceIso),
      ),
    );

  const nameMap = new Map(orgCompanies.map(c => [c.id, c.name]));
  type Agg = { inbound: number; outbound: number; missed: number };
  const aggByCompany = new Map<string, Agg>();
  const ensure = (cid: string): Agg => {
    let a = aggByCompany.get(cid);
    if (!a) { a = { inbound: 0, outbound: 0, missed: 0 }; aggByCompany.set(cid, a); }
    return a;
  };

  for (const tp of tps) {
    if (!tp.companyId) continue;
    if (!isWebexTouchpoint(tp.notes)) continue;
    const dir = detectDirection(tp.notes);
    if (!dir) continue;
    ensure(tp.companyId)[dir]++;
  }
  for (const card of cards) {
    if (!card.companyId) continue;
    ensure(card.companyId).missed++;
  }

  let tIn = 0, tOut = 0, tMissed = 0;
  const rows: LaneRollupRow[] = [];
  for (const [cid, agg] of aggByCompany.entries()) {
    const total = agg.inbound + agg.outbound + agg.missed;
    tIn += agg.inbound; tOut += agg.outbound; tMissed += agg.missed;
    rows.push({
      companyId: cid,
      companyName: nameMap.get(cid) || "Unknown",
      contactCount: contactByCompany.get(cid)?.size ?? 0,
      inbound: agg.inbound,
      outbound: agg.outbound,
      missed: agg.missed,
      total,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  return {
    lane,
    days,
    rows,
    totals: {
      inbound: tIn,
      outbound: tOut,
      missed: tMissed,
      total: tIn + tOut + tMissed,
      companies: contactByCompany.size,
      contacts: matchedContacts.length,
    },
  };
}
