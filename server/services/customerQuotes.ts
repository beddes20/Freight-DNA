import { and, eq, asc, desc, sql, type SQL } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteCustomers, quoteReps, quoteCarriers, quoteLaneGroups, quoteOutcomeReasons,
  quoteOpportunities, quoteEvents, quoteSavedViews,
  type QuoteOpportunity, type QuoteOutcomeStatus, type QuoteCustomer, type QuoteRep,
  type QuoteCarrier, type QuoteLaneGroup, type QuoteOutcomeReason, type QuoteSavedView,
} from "@shared/schema";
import { getStaleQuoteFollowUps } from "./staleQuoteFollowup";
import { getActivePatternAlertsForOrg } from "./quotePatternShift";

export type QuoteFilters = {
  customerId?: string;
  startDate?: string;
  endDate?: string;
  equipment?: string;
  repId?: string;
  outcomeStatus?: string;
  outcomeReasonId?: string;
  laneSearch?: string;
  laneGroupId?: string;
  wonOnly?: boolean;
  activeOnly?: boolean;
  lostOnly?: boolean;
  expiringOnly?: boolean;
};

export type EnrichedQuote = QuoteOpportunity & {
  customerName: string;
  repName: string;
  carrierName: string | null;
  outcomeReasonLabel: string | null;
};

export type AlertSeverity = "high" | "medium" | "low";
export type Alert = {
  id: string;
  severity: AlertSeverity;
  type: string;
  title: string;
  detail: string;
  data?: { lane?: string; customerId?: string; quoteId?: string; startDate?: string };
};

export type StaleFollowUpItem = {
  quoteId: string;
  customerId: string;
  customerName: string;
  lane: string;
  ageHours: number;
  pTypicalHours: number;
  hoursOverdue: number;
  quotedAmount: number;
  estimatedMargin: number;
  repName: string | null;
};

export type CustomerPerformance = {
  customer: QuoteCustomer;
  winCount: number;
  lossCount: number;
  avgQuoted: number;
  avgCarrierBuy: number;
  topLanes: { lane: string; total: number; won: number; quoted: number; paid: number }[];
  topLossReasons: { reason: string; count: number }[];
};

export type LaneVarianceItem = {
  lane: string;
  min: number;
  max: number;
  spread: number;
  spreadPct: number;
  breakdown: { rep: string; avg: number }[];
};

export type AttractivenessItem = {
  customer: string;
  lane: string;
  total: number;
  won: number;
  winRate: number;
  avgMargin: number;
  label: "Pursue Aggressively" | "Good Freight" | "Selective" | "Low Quality";
};

export type ChartBucket = { date: string; total: number; won: number; lost: number };

export type Snapshot = {
  total: number;
  kpis: {
    total: number; won: number; lost: number; winRate: number;
    avgQuoted: number; avgCarrierCost: number;
    avgMarginDollar: number; avgMarginPct: number;
    avgResponseTime: number; pending: number; expiringSoon: number;
    trend: { winRate: number; total: number; avgMargin: number; avgResponse: number };
  };
  customers: QuoteCustomer[];
  reps: QuoteRep[];
  reasons: QuoteOutcomeReason[];
  laneGroups: QuoteLaneGroup[];
  carriers: QuoteCarrier[];
  customerPerformance: CustomerPerformance | null;
  taxonomy: Record<string, number>;
  validityWindow: {
    expiringList: { id: string; lane: string; customer: string; validThrough: string; quotedAmount: number }[];
    agingBuckets: Record<string, number>;
    staleCount: number; activeCount: number; expiredCount: number;
  };
  laneVariance: LaneVarianceItem[];
  attractiveness: AttractivenessItem[];
  staleFollowUps: StaleFollowUpItem[];
  charts: {
    trend: ChartBucket[];
    winRateByCustomer: { customer: string; winRate: number; total: number }[];
    marginByCustomer: { customer: string; avgMargin: number; won: number }[];
    topLanes: { lane: string; total: number; won: number }[];
    highVolLowWin: { lane: string; total: number; won: number }[];
  };
  alerts: Alert[];
};

export type ListSortKey =
  | "requestDate" | "customerName" | "originCity" | "destCity" | "equipment"
  | "quotedAmount" | "validThrough" | "outcomeStatus" | "outcomeReasonLabel"
  | "carrierPaid" | "marginDollar" | "marginPct" | "repName" | "responseTimeHours"
  | "source" | "score";

export type ListResult = {
  rows: EnrichedQuote[];
  total: number;
  offset: number;
  limit: number;
};

const WON_STATUSES: QuoteOutcomeStatus[] = ["won", "won_low_margin"];
const ACTIVE_STATUSES: QuoteOutcomeStatus[] = ["pending"];
const LOST_STATUSES: QuoteOutcomeStatus[] = ["lost_price", "lost_service", "lost_timing", "lost_incumbent"];

function isWon(s: string): boolean { return s === "won" || s === "won_low_margin"; }
function isLost(s: string): boolean { return s === "lost_price" || s === "lost_service" || s === "lost_timing" || s === "lost_incumbent"; }

/**
 * Demo seed gate (Task #470).
 *
 * The 140-row demo dataset is useful for local/staging walkthroughs but must
 * never auto-populate a production org — real quote data should arrive via the
 * inbound email parser (see `quoteEmailIngestion.ts`) and the TMS outcome
 * sync (see `quoteTmsSync.ts`).
 *
 * The seed runs only when `QUOTE_DEMO_SEED_ENABLED=true`. An optional
 * `QUOTE_DEMO_SEED_ORG_IDS` allow-list further restricts which orgs receive
 * the demo data. Production deploys leave the flag unset, so calling
 * `ensureQuoteSeed` is a no-op for live customers and the Customer Quotes UI
 * starts from an empty state until real ingestion lands rows.
 */
export function isDemoSeedEnabled(orgId?: string): boolean {
  if (process.env.QUOTE_DEMO_SEED_ENABLED !== "true") return false;
  const allow = process.env.QUOTE_DEMO_SEED_ORG_IDS;
  if (!allow || !orgId) return true;
  const ids = allow.split(",").map(s => s.trim()).filter(Boolean);
  return ids.length === 0 || ids.includes(orgId);
}

export async function ensureQuoteSeed(orgId: string): Promise<void> {
  if (!isDemoSeedEnabled(orgId)) return;
  const existing = await db.select({ id: quoteCustomers.id }).from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)).limit(1);
  if (existing.length > 0) return;
  await seedDemoData(orgId);
}

async function seedDemoData(orgId: string): Promise<void> {
  const customersData = [
    { name: "Aurora Foods", segment: "CPG" },
    { name: "Northwind Industrial", segment: "Industrial" },
    { name: "Cascade Beverage Co", segment: "Beverage" },
    { name: "Summit Building Products", segment: "Building Materials" },
    { name: "Harbor Retail Group", segment: "Retail" },
    { name: "Pioneer Auto Parts", segment: "Automotive" },
  ];
  const customers = await db.insert(quoteCustomers).values(
    customersData.map(c => ({ organizationId: orgId, ...c }))
  ).returning();

  const repsData = [
    { name: "Jamie Carter", email: "jamie@example.com" },
    { name: "Riley Cohen", email: "riley@example.com" },
    { name: "Morgan Patel", email: "morgan@example.com" },
    { name: "Sam Reyes", email: "sam@example.com" },
    { name: "Avery Brooks", email: "avery@example.com" },
  ];
  const reps = await db.insert(quoteReps).values(
    repsData.map(r => ({ organizationId: orgId, ...r }))
  ).returning();

  const carriersData = ["Granite Logistics", "Skyway Carriers", "Ironwood Freight", "BlueRidge Transport", "Cobalt Trucking", "Highmark Lines", "Greenfield Express"];
  const carriers = await db.insert(quoteCarriers).values(carriersData.map(n => ({ organizationId: orgId, name: n }))).returning();

  const laneGroupsData = [
    { name: "Midwest → Southeast", originRegion: "Midwest", destRegion: "Southeast" },
    { name: "PNW → California", originRegion: "Pacific Northwest", destRegion: "California" },
    { name: "Texas → Northeast", originRegion: "Texas", destRegion: "Northeast" },
    { name: "Southeast → Midwest", originRegion: "Southeast", destRegion: "Midwest" },
    { name: "California → Mountain", originRegion: "California", destRegion: "Mountain" },
  ];
  const laneGroups = await db.insert(quoteLaneGroups).values(laneGroupsData.map(g => ({ organizationId: orgId, ...g }))).returning();

  const reasonsData = [
    { code: "won_competitive", label: "Competitive rate", category: "won" },
    { code: "won_capacity", label: "Capacity availability", category: "won" },
    { code: "won_relationship", label: "Strong relationship", category: "won" },
    { code: "lost_price_high", label: "Price too high", category: "lost" },
    { code: "lost_service_concerns", label: "Service concerns", category: "lost" },
    { code: "lost_timing", label: "Couldn't meet pickup", category: "lost" },
    { code: "lost_incumbent_won", label: "Incumbent kept it", category: "lost" },
    { code: "no_response", label: "No response from customer", category: "no_response" },
    { code: "expired", label: "Quote expired", category: "expired" },
  ];
  const reasons = await db.insert(quoteOutcomeReasons).values(reasonsData.map(r => ({ organizationId: orgId, ...r }))).returning();

  const lanes = [
    { o: "Chicago", os: "IL", d: "Atlanta", ds: "GA", lgIdx: 0 },
    { o: "Indianapolis", os: "IN", d: "Charlotte", ds: "NC", lgIdx: 0 },
    { o: "Columbus", os: "OH", d: "Jacksonville", ds: "FL", lgIdx: 0 },
    { o: "Portland", os: "OR", d: "Los Angeles", ds: "CA", lgIdx: 1 },
    { o: "Seattle", os: "WA", d: "Oakland", ds: "CA", lgIdx: 1 },
    { o: "Dallas", os: "TX", d: "Newark", ds: "NJ", lgIdx: 2 },
    { o: "Houston", os: "TX", d: "Boston", ds: "MA", lgIdx: 2 },
    { o: "Atlanta", os: "GA", d: "Chicago", ds: "IL", lgIdx: 3 },
    { o: "Memphis", os: "TN", d: "St Louis", ds: "MO", lgIdx: 3 },
    { o: "Los Angeles", os: "CA", d: "Denver", ds: "CO", lgIdx: 4 },
  ];
  const equipments = ["Dry Van", "Reefer", "Flatbed"];
  const sources = ["email", "tms", "crm", "manual"];
  const outcomePool: QuoteOutcomeStatus[] = [
    ...Array(18).fill("won"), ...Array(4).fill("won_low_margin"),
    ...Array(14).fill("lost_price"), ...Array(6).fill("lost_service"),
    ...Array(5).fill("lost_timing"), ...Array(7).fill("lost_incumbent"),
    ...Array(10).fill("no_response"), ...Array(8).fill("expired"),
    ...Array(12).fill("pending"),
  ] as QuoteOutcomeStatus[];

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let seed = 1;
  const rand = (): number => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const between = (a: number, b: number): number => a + rand() * (b - a);

  const insertOpps: typeof quoteOpportunities.$inferInsert[] = [];

  for (let i = 0; i < 140; i++) {
    const lane = pick(lanes);
    const customer = pick(customers);
    const rep = pick(reps);
    const carrier = pick(carriers);
    const equipment = pick(equipments);
    const source = pick(sources);
    const status = pick(outcomePool);
    const ageDays = Math.floor(rand() * 90);
    const requestDate = new Date(now - ageDays * dayMs);
    let baseRate = 1800;
    if (equipment === "Reefer") baseRate = 2200;
    if (equipment === "Flatbed") baseRate = 2050;
    const distFactor = 0.85 + rand() * 0.5;
    const quoted = Math.round(baseRate * distFactor + between(-150, 220));
    let validThrough: Date | null = new Date(requestDate.getTime() + 7 * dayMs);
    let carrierPaid: number | null = null;
    let outcomeReason: QuoteOutcomeReason | null = null;
    const responseHours = Number(between(0.5, 36).toFixed(1));

    if (status === "won" || status === "won_low_margin") {
      const margin = status === "won_low_margin" ? between(40, 110) : between(180, 480);
      carrierPaid = Math.max(900, Math.round(quoted - margin));
      outcomeReason = reasons.find(r => r.category === "won") ?? null;
    } else if (LOST_STATUSES.includes(status)) {
      const codeMap: Record<string, string> = {
        lost_price: "lost_price_high", lost_service: "lost_service_concerns",
        lost_timing: "lost_timing", lost_incumbent: "lost_incumbent_won",
      };
      outcomeReason = reasons.find(r => r.code === codeMap[status]) ?? null;
    } else if (status === "no_response") {
      outcomeReason = reasons.find(r => r.code === "no_response") ?? null;
    } else if (status === "expired") {
      outcomeReason = reasons.find(r => r.code === "expired") ?? null;
      validThrough = new Date(requestDate.getTime() + 5 * dayMs);
    } else if (status === "pending") {
      validThrough = new Date(now + Math.floor(between(-1, 14)) * dayMs);
    }
    const score = Math.round(between(40, 95));

    insertOpps.push({
      organizationId: orgId, customerId: customer.id, repId: rep.id,
      laneGroupId: laneGroups[lane.lgIdx].id,
      carrierId: carrierPaid !== null ? carrier.id : null,
      outcomeReasonId: outcomeReason?.id ?? null,
      requestDate, originCity: lane.o, originState: lane.os,
      destCity: lane.d, destState: lane.ds, equipment,
      quotedAmount: String(quoted), validThrough, outcomeStatus: status,
      carrierPaid: carrierPaid !== null ? String(carrierPaid) : null,
      responseTimeHours: String(responseHours), source,
      sourceReference: `${source.toUpperCase()}-${1000 + i}`,
      notes: null, score: String(score),
    });
  }

  const inserted = await db.insert(quoteOpportunities).values(insertOpps).returning();

  const eventBatches: typeof quoteEvents.$inferInsert[] = [];
  for (const opp of inserted) {
    eventBatches.push({ quoteId: opp.id, eventType: "requested", occurredAt: opp.requestDate, actor: "Customer", payload: { source: opp.source, reference: opp.sourceReference } });
    eventBatches.push({ quoteId: opp.id, eventType: "quoted", occurredAt: new Date(opp.requestDate.getTime() + Number(opp.responseTimeHours ?? 4) * 3600 * 1000), actor: "Rep", payload: { quotedAmount: opp.quotedAmount } });
    if (rand() > 0.6) {
      eventBatches.push({ quoteId: opp.id, eventType: "revised", occurredAt: new Date(opp.requestDate.getTime() + (Number(opp.responseTimeHours ?? 4) + 6) * 3600 * 1000), actor: "Rep", payload: { quotedAmount: String(Math.round(Number(opp.quotedAmount) * 0.97)) } });
    }
    if (isWon(opp.outcomeStatus)) {
      eventBatches.push({ quoteId: opp.id, eventType: "won", occurredAt: new Date(opp.requestDate.getTime() + 2 * dayMs), actor: "System", payload: { carrierPaid: opp.carrierPaid } });
    } else if (isLost(opp.outcomeStatus)) {
      eventBatches.push({ quoteId: opp.id, eventType: "lost", occurredAt: new Date(opp.requestDate.getTime() + 2 * dayMs), actor: "System", payload: {} });
    } else if (opp.outcomeStatus === "expired") {
      eventBatches.push({ quoteId: opp.id, eventType: "expired", occurredAt: opp.validThrough ?? new Date(opp.requestDate.getTime() + 5 * dayMs), actor: "System", payload: {} });
    }
  }
  const chunk = 200;
  for (let i = 0; i < eventBatches.length; i += chunk) {
    await db.insert(quoteEvents).values(eventBatches.slice(i, i + chunk));
  }
}

function applyFilters(rows: QuoteOpportunity[], f: QuoteFilters): QuoteOpportunity[] {
  return rows.filter((r) => {
    if (f.customerId && r.customerId !== f.customerId) return false;
    if (f.laneGroupId && r.laneGroupId !== f.laneGroupId) return false;
    if (f.repId && r.repId !== f.repId) return false;
    if (f.equipment && r.equipment !== f.equipment) return false;
    if (f.outcomeStatus && r.outcomeStatus !== f.outcomeStatus) return false;
    if (f.outcomeReasonId && r.outcomeReasonId !== f.outcomeReasonId) return false;
    if (f.startDate) { const d = new Date(f.startDate); if (r.requestDate < d) return false; }
    if (f.endDate) { const d = new Date(f.endDate); if (r.requestDate > d) return false; }
    if (f.wonOnly && !isWon(r.outcomeStatus)) return false;
    if (f.lostOnly && !isLost(r.outcomeStatus)) return false;
    if (f.activeOnly && !ACTIVE_STATUSES.includes(r.outcomeStatus as QuoteOutcomeStatus)) return false;
    if (f.expiringOnly) {
      if (r.outcomeStatus !== "pending" || !r.validThrough) return false;
      const ms = r.validThrough.getTime() - Date.now();
      if (ms < 0 || ms > 3 * 24 * 3600 * 1000) return false;
    }
    if (f.laneSearch) {
      const lane = `${r.originCity},${r.originState} ${r.destCity},${r.destState}`.toLowerCase();
      const tokens = f.laneSearch.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.every(t => lane.includes(t))) return false;
    }
    return true;
  });
}

function num(v: string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v); return isNaN(n) ? 0 : n;
}

function enrich(
  rows: QuoteOpportunity[],
  customerMap: Map<string, QuoteCustomer>,
  repMap: Map<string, QuoteRep>,
  carrierMap: Map<string, QuoteCarrier>,
  reasonMap: Map<string, QuoteOutcomeReason>,
): EnrichedQuote[] {
  return rows.map(r => ({
    ...r,
    customerName: customerMap.get(r.customerId)?.name ?? "—",
    repName: r.repId ? repMap.get(r.repId)?.name ?? "—" : "—",
    carrierName: r.carrierId ? carrierMap.get(r.carrierId)?.name ?? null : null,
    outcomeReasonLabel: r.outcomeReasonId ? reasonMap.get(r.outcomeReasonId)?.label ?? null : null,
  }));
}

async function loadContext(orgId: string) {
  const [customers, reps, reasons, laneGroups, carriers] = await Promise.all([
    db.select().from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)).orderBy(asc(quoteCustomers.name)),
    db.select().from(quoteReps).where(eq(quoteReps.organizationId, orgId)).orderBy(asc(quoteReps.name)),
    db.select().from(quoteOutcomeReasons).where(eq(quoteOutcomeReasons.organizationId, orgId)),
    db.select().from(quoteLaneGroups).where(eq(quoteLaneGroups.organizationId, orgId)),
    db.select().from(quoteCarriers).where(eq(quoteCarriers.organizationId, orgId)),
  ]);
  return {
    customers, reps, reasons, laneGroups, carriers,
    customerMap: new Map(customers.map(c => [c.id, c])),
    repMap: new Map(reps.map(r => [r.id, r])),
    reasonMap: new Map(reasons.map(r => [r.id, r])),
    carrierMap: new Map(carriers.map(c => [c.id, c])),
  };
}

export async function listQuotes(orgId: string, filters: QuoteFilters, sortKey: ListSortKey, sortDir: "asc" | "desc", offset: number, limit: number): Promise<ListResult> {
  const ctx = await loadContext(orgId);
  const all = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));
  const filtered = applyFilters(all, filters);
  const enriched = enrich(filtered, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);

  const dir = sortDir === "asc" ? 1 : -1;
  enriched.sort((a, b) => {
    let av: number | string = "";
    let bv: number | string = "";
    switch (sortKey) {
      case "requestDate":
        av = a.requestDate.getTime(); bv = b.requestDate.getTime(); break;
      case "validThrough":
        av = a.validThrough ? a.validThrough.getTime() : 0;
        bv = b.validThrough ? b.validThrough.getTime() : 0; break;
      case "quotedAmount": av = num(a.quotedAmount); bv = num(b.quotedAmount); break;
      case "carrierPaid": av = num(a.carrierPaid); bv = num(b.carrierPaid); break;
      case "responseTimeHours": av = num(a.responseTimeHours); bv = num(b.responseTimeHours); break;
      case "score": av = num(a.score); bv = num(b.score); break;
      case "marginDollar":
        av = num(a.quotedAmount) - num(a.carrierPaid);
        bv = num(b.quotedAmount) - num(b.carrierPaid); break;
      case "marginPct": {
        const ad = num(a.quotedAmount), bd = num(b.quotedAmount);
        av = ad > 0 && num(a.carrierPaid) > 0 ? (ad - num(a.carrierPaid)) / ad : 0;
        bv = bd > 0 && num(b.carrierPaid) > 0 ? (bd - num(b.carrierPaid)) / bd : 0; break;
      }
      case "customerName": av = a.customerName.toLowerCase(); bv = b.customerName.toLowerCase(); break;
      case "originCity": av = `${a.originCity},${a.originState}`.toLowerCase(); bv = `${b.originCity},${b.originState}`.toLowerCase(); break;
      case "destCity": av = `${a.destCity},${a.destState}`.toLowerCase(); bv = `${b.destCity},${b.destState}`.toLowerCase(); break;
      case "equipment": av = a.equipment.toLowerCase(); bv = b.equipment.toLowerCase(); break;
      case "outcomeStatus": av = a.outcomeStatus; bv = b.outcomeStatus; break;
      case "outcomeReasonLabel": av = (a.outcomeReasonLabel ?? "").toLowerCase(); bv = (b.outcomeReasonLabel ?? "").toLowerCase(); break;
      case "repName": av = a.repName.toLowerCase(); bv = b.repName.toLowerCase(); break;
      case "source": av = a.source; bv = b.source; break;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  return {
    rows: enriched.slice(offset, offset + limit),
    total: enriched.length,
    offset, limit,
  };
}

export async function getSnapshot(orgId: string, filters: QuoteFilters): Promise<Snapshot> {
  const ctx = await loadContext(orgId);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId))
    .orderBy(desc(quoteOpportunities.requestDate));

  const filtered = applyFilters(allOpps, filters);
  const won = filtered.filter(r => isWon(r.outcomeStatus));
  const lost = filtered.filter(r => isLost(r.outcomeStatus));
  const pending = filtered.filter(r => r.outcomeStatus === "pending");

  const total = filtered.length;
  const decided = won.length + lost.length;
  const winRate = decided > 0 ? (won.length / decided) * 100 : 0;
  const avgQuoted = total > 0 ? filtered.reduce((s, r) => s + num(r.quotedAmount), 0) / total : 0;
  const wonWithCarrier = won.filter(r => num(r.carrierPaid) > 0);
  const avgCarrierCost = wonWithCarrier.length > 0 ? wonWithCarrier.reduce((s, r) => s + num(r.carrierPaid), 0) / wonWithCarrier.length : 0;
  const avgMarginDollar = wonWithCarrier.length > 0 ? wonWithCarrier.reduce((s, r) => s + (num(r.quotedAmount) - num(r.carrierPaid)), 0) / wonWithCarrier.length : 0;
  const avgMarginPct = wonWithCarrier.length > 0 ? wonWithCarrier.reduce((s, r) => {
    const q = num(r.quotedAmount); if (!q) return s; return s + ((q - num(r.carrierPaid)) / q) * 100;
  }, 0) / wonWithCarrier.length : 0;
  const avgResponseTime = total > 0 ? filtered.reduce((s, r) => s + num(r.responseTimeHours), 0) / total : 0;

  const now = new Date();
  const expiringSoon = pending.filter(r => r.validThrough && r.validThrough.getTime() - now.getTime() < 3 * 24 * 3600 * 1000 && r.validThrough.getTime() > now.getTime()).length;

  // Trend (compare two halves of the period).
  const sorted = filtered.slice().sort((a, b) => a.requestDate.getTime() - b.requestDate.getTime());
  let trend = { winRate: 0, total: 0, avgMargin: 0, avgResponse: 0 };
  if (sorted.length > 4) {
    const half = Math.floor(sorted.length / 2);
    const a = sorted.slice(0, half);
    const b = sorted.slice(half);
    const wrA = a.filter(r => isWon(r.outcomeStatus)).length / Math.max(1, a.filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus)).length);
    const wrB = b.filter(r => isWon(r.outcomeStatus)).length / Math.max(1, b.filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus)).length);
    const avgMarg = (set: QuoteOpportunity[]) => {
      const wc = set.filter(r => isWon(r.outcomeStatus) && num(r.carrierPaid) > 0);
      return wc.length > 0 ? wc.reduce((s, r) => s + (num(r.quotedAmount) - num(r.carrierPaid)), 0) / wc.length : 0;
    };
    const avgResp = (set: QuoteOpportunity[]) => set.length > 0 ? set.reduce((s, r) => s + num(r.responseTimeHours), 0) / set.length : 0;
    trend = {
      winRate: (wrB - wrA) * 100,
      total: b.length - a.length,
      avgMargin: avgMarg(b) - avgMarg(a),
      avgResponse: avgResp(b) - avgResp(a),
    };
  }

  // Customer performance (when customer selected).
  let customerPerformance: CustomerPerformance | null = null;
  if (filters.customerId) {
    const cust = ctx.customerMap.get(filters.customerId);
    if (cust) {
      const laneAgg = new Map<string, { lane: string; total: number; won: number; quoted: number; paid: number }>();
      for (const r of filtered) {
        const k = `${r.originCity},${r.originState} → ${r.destCity},${r.destState}`;
        const cur = laneAgg.get(k) ?? { lane: k, total: 0, won: 0, quoted: 0, paid: 0 };
        cur.total++;
        if (isWon(r.outcomeStatus)) { cur.won++; cur.paid += num(r.carrierPaid); }
        cur.quoted += num(r.quotedAmount);
        laneAgg.set(k, cur);
      }
      const topLanes = Array.from(laneAgg.values()).sort((a, b) => b.total - a.total).slice(0, 6);
      const lossReasonAgg = new Map<string, number>();
      for (const r of lost) {
        const reason = ctx.reasonMap.get(r.outcomeReasonId ?? "");
        const key = reason?.label ?? "Unknown";
        lossReasonAgg.set(key, (lossReasonAgg.get(key) ?? 0) + 1);
      }
      const topLossReasons = Array.from(lossReasonAgg.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5);
      customerPerformance = { customer: cust, winCount: won.length, lossCount: lost.length, avgQuoted, avgCarrierBuy: avgCarrierCost, topLanes, topLossReasons };
    }
  }

  // Outcome taxonomy.
  const taxonomyCounts: Record<string, number> = {};
  for (const r of filtered) taxonomyCounts[r.outcomeStatus] = (taxonomyCounts[r.outcomeStatus] ?? 0) + 1;

  // Validity window.
  const expiringList = pending
    .filter(r => r.validThrough)
    .map(r => ({ id: r.id, lane: `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`, customer: ctx.customerMap.get(r.customerId)?.name ?? "—", validThrough: r.validThrough!.toISOString(), quotedAmount: num(r.quotedAmount) }))
    .sort((a, b) => new Date(a.validThrough).getTime() - new Date(b.validThrough).getTime())
    .slice(0, 12);
  const dayMs = 24 * 3600 * 1000;
  const agingBuckets: Record<string, number> = { "0-2d": 0, "3-7d": 0, "8-14d": 0, "15-30d": 0, "30+d": 0 };
  for (const r of filtered) {
    const ageDays = Math.floor((now.getTime() - r.requestDate.getTime()) / dayMs);
    if (ageDays <= 2) agingBuckets["0-2d"]++;
    else if (ageDays <= 7) agingBuckets["3-7d"]++;
    else if (ageDays <= 14) agingBuckets["8-14d"]++;
    else if (ageDays <= 30) agingBuckets["15-30d"]++;
    else agingBuckets["30+d"]++;
  }
  const staleCount = filtered.filter(r => r.outcomeStatus === "pending" && (now.getTime() - r.requestDate.getTime()) > 14 * dayMs).length;
  const activeCount = pending.length;
  const expiredCount = filtered.filter(r => r.outcomeStatus === "expired").length;

  // Lane variance.
  type RepBucket = Map<string, number[]>;
  const laneRepAgg = new Map<string, { lane: string; reps: RepBucket }>();
  for (const r of filtered) {
    const k = `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`;
    const cur = laneRepAgg.get(k) ?? { lane: k, reps: new Map() as RepBucket };
    if (r.repId) {
      const repName = ctx.repMap.get(r.repId)?.name ?? "Unknown";
      const arr = cur.reps.get(repName) ?? [];
      arr.push(num(r.quotedAmount));
      cur.reps.set(repName, arr);
    }
    laneRepAgg.set(k, cur);
  }
  const laneVariance: LaneVarianceItem[] = Array.from(laneRepAgg.values())
    .filter(l => l.reps.size > 1)
    .map(l => {
      const all: number[] = [];
      const breakdown: { rep: string; avg: number }[] = [];
      l.reps.forEach((arr, rep) => {
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        breakdown.push({ rep, avg });
        all.push(...arr);
      });
      const min = Math.min(...all), max = Math.max(...all);
      const spread = max - min;
      const spreadPct = min > 0 ? (spread / min) * 100 : 0;
      return { lane: l.lane, min, max, spread, spreadPct, breakdown };
    })
    .sort((a, b) => b.spreadPct - a.spreadPct)
    .slice(0, 8);

  // Freight attractiveness.
  const laneCustomerAgg = new Map<string, { customer: string; lane: string; total: number; won: number; margin: number; marginCount: number }>();
  for (const r of filtered) {
    const lane = `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`;
    const cust = ctx.customerMap.get(r.customerId)?.name ?? "—";
    const k = `${cust}::${lane}`;
    const cur = laneCustomerAgg.get(k) ?? { customer: cust, lane, total: 0, won: 0, margin: 0, marginCount: 0 };
    cur.total++;
    if (isWon(r.outcomeStatus)) {
      cur.won++;
      const m = num(r.quotedAmount) - num(r.carrierPaid);
      if (num(r.carrierPaid) > 0) { cur.margin += m; cur.marginCount++; }
    }
    laneCustomerAgg.set(k, cur);
  }
  const attractiveness: AttractivenessItem[] = Array.from(laneCustomerAgg.values())
    .filter(x => x.total >= 2)
    .map(x => {
      const wr = x.won / x.total;
      const avgM = x.marginCount > 0 ? x.margin / x.marginCount : 0;
      let label: AttractivenessItem["label"];
      if (wr >= 0.55 && avgM >= 200) label = "Pursue Aggressively";
      else if (wr >= 0.4 && avgM >= 120) label = "Good Freight";
      else if (wr >= 0.25) label = "Selective";
      else label = "Low Quality";
      return { customer: x.customer, lane: x.lane, total: x.total, won: x.won, winRate: wr * 100, avgMargin: avgM, label };
    })
    .sort((a, b) => b.winRate - a.winRate);

  // Charts.
  const days = 30;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const trendBuckets: ChartBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * dayMs);
    trendBuckets.push({ date: d.toISOString().slice(5, 10), total: 0, won: 0, lost: 0 });
  }
  for (const r of filtered) {
    const ageDays = Math.floor((today.getTime() - new Date(new Date(r.requestDate).setHours(0, 0, 0, 0)).getTime()) / dayMs);
    if (ageDays >= 0 && ageDays < days) {
      const idx = days - 1 - ageDays;
      trendBuckets[idx].total++;
      if (isWon(r.outcomeStatus)) trendBuckets[idx].won++;
      if (isLost(r.outcomeStatus)) trendBuckets[idx].lost++;
    }
  }

  const winRateByCustomer = Array.from(ctx.customerMap.values()).map(c => {
    const set = filtered.filter(r => r.customerId === c.id);
    const w = set.filter(r => isWon(r.outcomeStatus)).length;
    const l = set.filter(r => isLost(r.outcomeStatus)).length;
    const dec = w + l;
    return { customer: c.name, winRate: dec > 0 ? (w / dec) * 100 : 0, total: set.length };
  }).filter(x => x.total > 0).sort((a, b) => b.winRate - a.winRate);

  const marginByCustomer = Array.from(ctx.customerMap.values()).map(c => {
    const set = filtered.filter(r => r.customerId === c.id && isWon(r.outcomeStatus) && num(r.carrierPaid) > 0);
    const margin = set.length > 0 ? set.reduce((s, r) => s + (num(r.quotedAmount) - num(r.carrierPaid)), 0) / set.length : 0;
    return { customer: c.name, avgMargin: margin, won: set.length };
  }).filter(x => x.won > 0).sort((a, b) => b.avgMargin - a.avgMargin);

  const topLanesAgg = new Map<string, { lane: string; total: number; won: number }>();
  for (const r of filtered) {
    const k = `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`;
    const cur = topLanesAgg.get(k) ?? { lane: k, total: 0, won: 0 };
    cur.total++; if (isWon(r.outcomeStatus)) cur.won++;
    topLanesAgg.set(k, cur);
  }
  const topLanes = Array.from(topLanesAgg.values()).sort((a, b) => b.total - a.total).slice(0, 8);
  const highVolLowWin = topLanes.filter(l => l.total >= 4 && (l.won / l.total) < 0.3).slice(0, 6);

  // Alerts.
  const alerts: Alert[] = [];
  for (const lane of highVolLowWin) {
    alerts.push({ id: `lowwin-${lane.lane}`, severity: "high", type: "low_win_lane",
      title: "Low win-rate lane", detail: `${lane.lane} — ${lane.total} quotes, ${Math.round((lane.won / lane.total) * 100)}% win rate`, data: { lane: lane.lane } });
  }
  if (expiringSoon > 0) alerts.push({ id: "expiring", severity: "high", type: "expiring", title: `${expiringSoon} quotes expiring in <3 days`, detail: "Follow up before they roll." });
  for (const v of laneVariance.filter(v => v.spreadPct > 18).slice(0, 4)) {
    alerts.push({ id: `var-${v.lane}`, severity: "medium", type: "variance", title: "Internal price spread", detail: `${v.lane} — $${Math.round(v.spread)} between reps (${v.spreadPct.toFixed(0)}%)`, data: { lane: v.lane } });
  }
  const slow = filtered.filter(r => num(r.responseTimeHours) > 24).length;
  if (slow > 5) alerts.push({ id: "slow", severity: "medium", type: "slow_response", title: `${slow} quotes responded to in >24h`, detail: "Pace is below SLA target." });
  const cutoff14 = now.getTime() - 14 * dayMs;
  const cutoff28 = now.getTime() - 28 * dayMs;
  for (const c of ctx.customers) {
    const recent = allOpps.filter(r => r.customerId === c.id && r.requestDate.getTime() >= cutoff14).length;
    const prior = allOpps.filter(r => r.customerId === c.id && r.requestDate.getTime() < cutoff14 && r.requestDate.getTime() >= cutoff28).length;
    if (recent >= 5 && recent > prior * 1.5 && prior > 0) {
      alerts.push({ id: `rise-${c.id}`, severity: "low", type: "rising_volume", title: `${c.name} ramping up`, detail: `${recent} quotes last 14d vs ${prior} prior — pursue the relationship.`, data: { customerId: c.id } });
    }
  }
  const lowMargin = won.filter(r => num(r.carrierPaid) > 0 && num(r.quotedAmount) > 0 && (num(r.quotedAmount) - num(r.carrierPaid)) / num(r.quotedAmount) < 0.06).length;
  if (lowMargin > 3) alerts.push({ id: "lowmargin", severity: "medium", type: "low_margin", title: `${lowMargin} loads at <6% margin`, detail: "Won-but-low-margin risk." });

  // Stale follow-ups (Task #480) — surface pending quotes past customer's typical decision window.
  const staleFollowUpsRaw = await getStaleQuoteFollowUps(orgId).catch((err) => {
    console.error("[customer-quotes] staleFollowUps error:", err);
    return [];
  });
  let staleFiltered = staleFollowUpsRaw;
  if (filters.customerId) staleFiltered = staleFiltered.filter(s => s.customerId === filters.customerId);
  const staleFollowUps: StaleFollowUpItem[] = staleFiltered.slice(0, 25).map(s => ({
    quoteId: s.quoteId, customerId: s.customerId, customerName: s.customerName,
    lane: s.lane, ageHours: s.ageHours, pTypicalHours: s.pTypicalHours,
    hoursOverdue: s.hoursOverdue, quotedAmount: s.quotedAmount,
    estimatedMargin: s.estimatedMargin, repName: s.repName,
  }));
  if (staleFollowUps.length > 0) {
    const top = staleFollowUps[0];
    alerts.push({
      id: "stale-followups", severity: "high", type: "stale_followup_summary",
      title: `${staleFollowUps.length} stale follow-up${staleFollowUps.length === 1 ? "" : "s"}`,
      detail: `Top: ${top.customerName} — ${Math.round(top.hoursOverdue)}h past typical (${Math.round(top.pTypicalHours)}h).`,
      data: { quoteId: top.quoteId },
    });
  }

  // Pattern-shift alerts (Task #481) — surfaced from the persisted detector.
  // Honor the customer filter so the panel stays scoped to the active slice.
  try {
    const patternAlerts = await getActivePatternAlertsForOrg(orgId);
    const startDate = new Date(now.getTime() - 30 * dayMs).toISOString().slice(0, 10);
    for (const pa of patternAlerts) {
      if (filters.customerId && pa.customerId !== filters.customerId) continue;
      const cust = ctx.customerMap.get(pa.customerId);
      if (!cust) continue;
      alerts.push({
        id: `pattern-shift-${pa.id}`,
        severity: "high",
        type: "pattern_shift",
        title: `Pattern shift — ${cust.name}`,
        detail: pa.summary,
        data: { customerId: pa.customerId, startDate },
      });
    }
  } catch (err) {
    console.error("[customer-quotes] pattern alert load error:", err);
  }
  // Lost-streak alerts (Task #478) — competitive-displacement early warning.
  // Computed against the entire org dataset (allOpps), not the user-filtered slice,
  // so the alert fires even when the user has narrowed the page to a different view.
  const streakAlerts = computeLostStreakAlerts(allOpps, ctx.customerMap, new Map(ctx.laneGroups.map(lg => [lg.id, lg])));
  for (const sa of streakAlerts) alerts.push(sa.alert);

  return {
    total,
    kpis: { total, won: won.length, lost: lost.length, winRate, avgQuoted, avgCarrierCost, avgMarginDollar, avgMarginPct, avgResponseTime, pending: pending.length, expiringSoon, trend },
    customers: ctx.customers, reps: ctx.reps, reasons: ctx.reasons, laneGroups: ctx.laneGroups, carriers: ctx.carriers,
    customerPerformance, taxonomy: taxonomyCounts,
    validityWindow: { expiringList, agingBuckets, staleCount, activeCount, expiredCount },
    laneVariance, attractiveness,
    staleFollowUps,
    charts: { trend: trendBuckets, winRateByCustomer, marginByCustomer, topLanes, highVolLowWin },
    alerts,
  };
}

export type QuoteDetail = {
  opp: QuoteOpportunity;
  events: typeof quoteEvents.$inferSelect[];
  customer: QuoteCustomer | null;
  rep: QuoteRep | null;
  carrier: QuoteCarrier | null;
  reason: QuoteOutcomeReason | null;
  relatedSameLane: QuoteOpportunity[];
  relatedSameCustomer: QuoteOpportunity[];
  relatedSameLaneGroup: QuoteOpportunity[];
};

export async function getQuoteDetail(orgId: string, quoteId: string): Promise<QuoteDetail | null> {
  const [opp] = await db.select().from(quoteOpportunities)
    .where(and(eq(quoteOpportunities.organizationId, orgId), eq(quoteOpportunities.id, quoteId)))
    .limit(1);
  if (!opp) return null;
  const [events, customer, rep, carrier, reason, sameLane, sameCustomer, sameLaneGroup] = await Promise.all([
    db.select().from(quoteEvents).where(eq(quoteEvents.quoteId, quoteId)).orderBy(asc(quoteEvents.occurredAt)),
    db.select().from(quoteCustomers).where(eq(quoteCustomers.id, opp.customerId)).limit(1).then(r => r[0] ?? null),
    opp.repId ? db.select().from(quoteReps).where(eq(quoteReps.id, opp.repId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
    opp.carrierId ? db.select().from(quoteCarriers).where(eq(quoteCarriers.id, opp.carrierId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
    opp.outcomeReasonId ? db.select().from(quoteOutcomeReasons).where(eq(quoteOutcomeReasons.id, opp.outcomeReasonId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
    db.select().from(quoteOpportunities).where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.originCity, opp.originCity),
      eq(quoteOpportunities.destCity, opp.destCity),
    )).orderBy(desc(quoteOpportunities.requestDate)).limit(20),
    db.select().from(quoteOpportunities).where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.customerId, opp.customerId),
    )).orderBy(desc(quoteOpportunities.requestDate)).limit(20),
    opp.laneGroupId ? db.select().from(quoteOpportunities).where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.laneGroupId, opp.laneGroupId),
    )).orderBy(desc(quoteOpportunities.requestDate)).limit(20) : Promise.resolve([]),
  ]);
  return {
    opp, events, customer, rep, carrier, reason,
    relatedSameLane: sameLane.filter(r => r.id !== quoteId),
    relatedSameCustomer: sameCustomer.filter(r => r.id !== quoteId),
    relatedSameLaneGroup: sameLaneGroup.filter(r => r.id !== quoteId && r.originCity !== opp.originCity),
  };
}

export async function listSavedViews(orgId: string): Promise<QuoteSavedView[]> {
  return db.select().from(quoteSavedViews)
    .where(eq(quoteSavedViews.organizationId, orgId))
    .orderBy(desc(quoteSavedViews.createdAt));
}

export async function createSavedView(orgId: string, userId: string, name: string, filters: QuoteFilters): Promise<QuoteSavedView> {
  const [row] = await db.insert(quoteSavedViews)
    .values({ organizationId: orgId, userId, name, filters })
    .returning();
  return row;
}

export async function deleteSavedView(orgId: string, userId: string, id: string): Promise<void> {
  // Creator-scoped delete.
  await db.delete(quoteSavedViews).where(and(
    eq(quoteSavedViews.organizationId, orgId),
    eq(quoteSavedViews.id, id),
    eq(quoteSavedViews.userId, userId),
  ));
}

export function quotesToCsv(quotes: EnrichedQuote[]): string {
  const headers = [
    "Request Date", "Customer", "Origin", "Destination", "Equipment",
    "Quoted Amount", "Valid Through", "Outcome Status", "Outcome Reason",
    "Carrier Paid", "Margin $", "Margin %", "Rep", "Response Time (h)", "Source", "Score",
  ];
  const rows = quotes.map(q => {
    const quoted = num(q.quotedAmount);
    const paid = num(q.carrierPaid);
    const margin = quoted - paid;
    const marginPct = quoted > 0 && paid > 0 ? (margin / quoted) * 100 : 0;
    return [
      q.requestDate ? new Date(q.requestDate).toISOString().slice(0, 10) : "",
      q.customerName, `${q.originCity}, ${q.originState}`, `${q.destCity}, ${q.destState}`,
      q.equipment, quoted ? quoted.toFixed(2) : "",
      q.validThrough ? new Date(q.validThrough).toISOString().slice(0, 10) : "",
      q.outcomeStatus, q.outcomeReasonLabel ?? "",
      paid ? paid.toFixed(2) : "", paid ? margin.toFixed(2) : "",
      paid ? marginPct.toFixed(1) : "", q.repName, num(q.responseTimeHours).toFixed(1),
      q.source, num(q.score).toFixed(0),
    ];
  });
  const escape = (v: unknown): string => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map(r => r.map(escape).join(",")).join("\n");
}

// ---------- Create / Update ----------

const TRACKED_FIELDS: Array<keyof QuoteOpportunity> = [
  "customerId", "repId", "carrierId", "outcomeReasonId",
  "originCity", "originState", "destCity", "destState",
  "equipment", "quotedAmount", "validThrough", "outcomeStatus",
  "carrierPaid", "responseTimeHours", "source", "sourceReference",
  "notes", "score",
];

export type CreateQuoteInput = {
  customerId: string;
  repId?: string | null;
  carrierId?: string | null;
  outcomeReasonId?: string | null;
  originCity: string; originState: string;
  destCity: string; destState: string;
  equipment: string;
  quotedAmount?: string | number | null;
  validThrough?: string | null;
  outcomeStatus?: QuoteOutcomeStatus;
  carrierPaid?: string | number | null;
  responseTimeHours?: string | number | null;
  source?: string;
  sourceReference?: string | null;
  notes?: string | null;
  score?: string | number | null;
  requestDate?: string | null;
};

export type UpdateQuoteInput = Partial<CreateQuoteInput>;

function toDecimalString(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!isFinite(n)) return null;
  return String(n);
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export async function createQuote(orgId: string, actor: string, input: CreateQuoteInput): Promise<QuoteOpportunity> {
  // Verify the customer belongs to the org.
  const [cust] = await db.select().from(quoteCustomers)
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, input.customerId))).limit(1);
  if (!cust) throw new Error("Invalid customer for organization");

  const reqDate = toDate(input.requestDate ?? null) ?? new Date();
  const status = (input.outcomeStatus ?? "pending") as QuoteOutcomeStatus;

  const [opp] = await db.insert(quoteOpportunities).values({
    organizationId: orgId,
    customerId: input.customerId,
    repId: input.repId ?? null,
    carrierId: input.carrierId ?? null,
    outcomeReasonId: input.outcomeReasonId ?? null,
    requestDate: reqDate,
    originCity: input.originCity,
    originState: input.originState,
    destCity: input.destCity,
    destState: input.destState,
    equipment: input.equipment,
    quotedAmount: toDecimalString(input.quotedAmount ?? null),
    validThrough: toDate(input.validThrough ?? null),
    outcomeStatus: status,
    carrierPaid: toDecimalString(input.carrierPaid ?? null),
    responseTimeHours: toDecimalString(input.responseTimeHours ?? null),
    source: input.source ?? "manual",
    sourceReference: input.sourceReference ?? null,
    notes: input.notes ?? null,
    score: toDecimalString(input.score ?? null),
  }).returning();

  // Audit trail.
  const events: typeof quoteEvents.$inferInsert[] = [
    { quoteId: opp.id, eventType: "requested", occurredAt: reqDate, actor,
      payload: { source: opp.source, reference: opp.sourceReference } },
  ];
  if (opp.quotedAmount) {
    events.push({ quoteId: opp.id, eventType: "quoted", occurredAt: new Date(), actor,
      payload: { quotedAmount: opp.quotedAmount } });
  }
  if (isWon(opp.outcomeStatus)) {
    events.push({ quoteId: opp.id, eventType: "won", occurredAt: new Date(), actor,
      payload: { carrierPaid: opp.carrierPaid } });
  } else if (isLost(opp.outcomeStatus)) {
    events.push({ quoteId: opp.id, eventType: "lost", occurredAt: new Date(), actor, payload: {} });
  } else if (opp.outcomeStatus === "expired") {
    events.push({ quoteId: opp.id, eventType: "expired", occurredAt: new Date(), actor, payload: {} });
  }
  await db.insert(quoteEvents).values(events);
  return opp;
}

export async function updateQuote(orgId: string, actor: string, id: string, patch: UpdateQuoteInput): Promise<QuoteOpportunity> {
  const [existing] = await db.select().from(quoteOpportunities)
    .where(and(eq(quoteOpportunities.organizationId, orgId), eq(quoteOpportunities.id, id))).limit(1);
  if (!existing) throw new Error("Quote not found");

  const next: Partial<typeof quoteOpportunities.$inferInsert> = {};
  if (patch.customerId !== undefined) next.customerId = patch.customerId;
  if (patch.repId !== undefined) next.repId = patch.repId;
  if (patch.carrierId !== undefined) next.carrierId = patch.carrierId;
  if (patch.outcomeReasonId !== undefined) next.outcomeReasonId = patch.outcomeReasonId;
  if (patch.originCity !== undefined) next.originCity = patch.originCity;
  if (patch.originState !== undefined) next.originState = patch.originState;
  if (patch.destCity !== undefined) next.destCity = patch.destCity;
  if (patch.destState !== undefined) next.destState = patch.destState;
  if (patch.equipment !== undefined) next.equipment = patch.equipment;
  if (patch.quotedAmount !== undefined) next.quotedAmount = toDecimalString(patch.quotedAmount);
  if (patch.validThrough !== undefined) next.validThrough = toDate(patch.validThrough);
  if (patch.outcomeStatus !== undefined) next.outcomeStatus = patch.outcomeStatus;
  if (patch.carrierPaid !== undefined) next.carrierPaid = toDecimalString(patch.carrierPaid);
  if (patch.responseTimeHours !== undefined) next.responseTimeHours = toDecimalString(patch.responseTimeHours);
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.sourceReference !== undefined) next.sourceReference = patch.sourceReference;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.score !== undefined) next.score = toDecimalString(patch.score);
  if (patch.requestDate !== undefined) {
    const d = toDate(patch.requestDate); if (d) next.requestDate = d;
  }

  const [updated] = await db.update(quoteOpportunities).set(next)
    .where(and(eq(quoteOpportunities.organizationId, orgId), eq(quoteOpportunities.id, id)))
    .returning();

  // Build diff for audit.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of TRACKED_FIELDS) {
    const a = existing[k];
    const b = updated[k];
    const aVal = a instanceof Date ? a.toISOString() : a;
    const bVal = b instanceof Date ? b.toISOString() : b;
    if (aVal !== bVal) changes[k] = { from: aVal, to: bVal };
  }

  const eventsToAdd: typeof quoteEvents.$inferInsert[] = [];
  const now = new Date();
  if (Object.keys(changes).length > 0) {
    eventsToAdd.push({ quoteId: id, eventType: "updated", occurredAt: now, actor, payload: { changes } });
  }
  if (changes.outcomeStatus) {
    const newStatus = updated.outcomeStatus;
    if (isWon(newStatus)) eventsToAdd.push({ quoteId: id, eventType: "won", occurredAt: now, actor, payload: { carrierPaid: updated.carrierPaid } });
    else if (isLost(newStatus)) eventsToAdd.push({ quoteId: id, eventType: "lost", occurredAt: now, actor, payload: {} });
    else if (newStatus === "expired") eventsToAdd.push({ quoteId: id, eventType: "expired", occurredAt: now, actor, payload: {} });
    else if (newStatus === "no_response") eventsToAdd.push({ quoteId: id, eventType: "no_response", occurredAt: now, actor, payload: {} });
  }
  if (changes.quotedAmount && !changes.outcomeStatus) {
    eventsToAdd.push({ quoteId: id, eventType: "revised", occurredAt: now, actor, payload: { quotedAmount: updated.quotedAmount } });
  }
  if (eventsToAdd.length > 0) await db.insert(quoteEvents).values(eventsToAdd);
  return updated;
}

// ---------- Lost-Streak Alerts (Task #478) ----------

export type LostStreakKind = "customer" | "lane";

export type LostStreakAlert = {
  kind: LostStreakKind;
  customerId?: string;
  laneGroupId?: string;
  laneGroupName?: string;
  customerName?: string;
  streakCount: number;
  windowDays: number;
  earliestLossId: string;
  earliestLossDate: string;
  latestLossDate: string;
  lastWonDate: string | null;
  recentRepIds: string[];
  dedupeKey: string;
  alert: Alert;
};

function lostStreakDefaults(): { threshold: number; windowDays: number } {
  const threshold = Math.max(2, Number(process.env.QUOTE_LOST_STREAK_THRESHOLD ?? "5") || 5);
  const windowDays = Math.max(7, Number(process.env.QUOTE_LOST_STREAK_WINDOW_DAYS ?? "60") || 60);
  return { threshold, windowDays };
}

export function computeLostStreakAlerts(
  allOpps: QuoteOpportunity[],
  customerMap: Map<string, QuoteCustomer>,
  laneGroupMap: Map<string, QuoteLaneGroup>,
  opts?: { threshold?: number; windowDays?: number },
): LostStreakAlert[] {
  const { threshold: defThreshold, windowDays: defWindow } = lostStreakDefaults();
  const threshold = opts?.threshold ?? defThreshold;
  const windowDays = opts?.windowDays ?? defWindow;
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;

  // Only count decided outcomes (won / lost) — pending/expired/no_response do
  // not break a streak but also aren't counted as a loss.
  const decided = allOpps
    .filter(o => isWon(o.outcomeStatus) || isLost(o.outcomeStatus))
    .filter(o => o.requestDate.getTime() >= cutoff)
    .slice()
    .sort((a, b) => b.requestDate.getTime() - a.requestDate.getTime());

  const out: LostStreakAlert[] = [];

  function fmtDate(iso: string): string { return iso.slice(0, 10); }

  function buildAlert(kind: LostStreakKind, key: string, list: QuoteOpportunity[]): LostStreakAlert | null {
    let streak = 0;
    let earliest: QuoteOpportunity | null = null;
    let latest: QuoteOpportunity | null = null;
    for (const q of list) {
      if (isLost(q.outcomeStatus)) {
        if (!latest) latest = q;
        streak++;
        earliest = q;
      } else {
        break; // a win breaks the streak
      }
    }
    if (streak < threshold || !earliest || !latest) return null;

    // Last won date — searched across the FULL history (not just window)
    // so the alert text can say "last won 9 months ago" or similar.
    const won = allOpps
      .filter(o => isWon(o.outcomeStatus))
      .filter(o => kind === "customer" ? o.customerId === key : o.laneGroupId === key)
      .sort((a, b) => b.requestDate.getTime() - a.requestDate.getTime())[0];
    const lastWonIso = won ? won.requestDate.toISOString() : null;

    const recentRepIds = Array.from(new Set(
      list.slice(0, streak).map(q => q.repId).filter((x): x is string => !!x),
    ));

    if (kind === "customer") {
      const cust = customerMap.get(key);
      const dedupe = `lost_streak_customer:${key}:since:${earliest.id}`;
      const lastWonStr = lastWonIso ? `last won ${fmtDate(lastWonIso)}` : "no recorded wins";
      const detail = `${streak} consecutive lost quotes in ${windowDays}d (since ${fmtDate(earliest.requestDate.toISOString())}) — ${lastWonStr}.`;
      return {
        kind, customerId: key, customerName: cust?.name,
        streakCount: streak, windowDays,
        earliestLossId: earliest.id,
        earliestLossDate: earliest.requestDate.toISOString(),
        latestLossDate: latest.requestDate.toISOString(),
        lastWonDate: lastWonIso,
        recentRepIds,
        dedupeKey: dedupe,
        alert: {
          id: dedupe, severity: "high", type: "lost_streak_customer",
          title: `${cust?.name ?? "Customer"} — ${streak} losses in a row`,
          detail,
          data: { customerId: key },
        },
      };
    } else {
      const lg = laneGroupMap.get(key);
      const dedupe = `lost_streak_lane:${key}:since:${earliest.id}`;
      const lastWonStr = lastWonIso ? `last won ${fmtDate(lastWonIso)}` : "no recorded wins";
      const detail = `${streak} consecutive losses on this lane group in ${windowDays}d (since ${fmtDate(earliest.requestDate.toISOString())}) — ${lastWonStr}.`;
      return {
        kind, laneGroupId: key, laneGroupName: lg?.name,
        streakCount: streak, windowDays,
        earliestLossId: earliest.id,
        earliestLossDate: earliest.requestDate.toISOString(),
        latestLossDate: latest.requestDate.toISOString(),
        lastWonDate: lastWonIso,
        recentRepIds,
        dedupeKey: dedupe,
        alert: {
          id: dedupe, severity: "high", type: "lost_streak_lane",
          title: `${lg?.name ?? "Lane group"} — ${streak} losses in a row`,
          detail,
          data: { lane: lg?.name },
        },
      };
    }
  }

  // Per-customer streaks
  const byCust = new Map<string, QuoteOpportunity[]>();
  for (const o of decided) {
    const arr = byCust.get(o.customerId) ?? [];
    arr.push(o); byCust.set(o.customerId, arr);
  }
  for (const [custId, list] of byCust) {
    const a = buildAlert("customer", custId, list);
    if (a) out.push(a);
  }

  // Per-lane-group streaks
  const byLane = new Map<string, QuoteOpportunity[]>();
  for (const o of decided) {
    if (!o.laneGroupId) continue;
    const arr = byLane.get(o.laneGroupId) ?? [];
    arr.push(o); byLane.set(o.laneGroupId, arr);
  }
  for (const [lgId, list] of byLane) {
    const a = buildAlert("lane", lgId, list);
    if (a) out.push(a);
  }

  return out;
}

export async function loadLostStreakAlertsForOrg(orgId: string, opts?: { threshold?: number; windowDays?: number }): Promise<LostStreakAlert[]> {
  const ctx = await loadContext(orgId);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));
  const laneGroupMap = new Map(ctx.laneGroups.map(lg => [lg.id, lg]));
  return computeLostStreakAlerts(allOpps, ctx.customerMap, laneGroupMap, opts);
}

export async function exportCsv(orgId: string, filters: QuoteFilters): Promise<string> {
  const ctx = await loadContext(orgId);
  const all = await db.select().from(quoteOpportunities).where(eq(quoteOpportunities.organizationId, orgId));
  const filtered = applyFilters(all, filters);
  const enriched = enrich(filtered, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);
  enriched.sort((a, b) => b.requestDate.getTime() - a.requestDate.getTime());
  return quotesToCsv(enriched);
}
