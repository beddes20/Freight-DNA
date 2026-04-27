import { and, eq, asc, desc, inArray, sql, type SQL } from "drizzle-orm";
import { db, storage } from "../storage";
import { logQuoteTouchpointFromEvent } from "./quoteTouchpoints";
import { carriers as carriersCatalog } from "@shared/schema";
import {
  quoteCustomers, quoteReps, quoteCarriers, quoteLaneGroups, quoteOutcomeReasons,
  quoteOpportunities, quoteEvents, quoteSavedViews,
  recurringLanes, companies, emailMessages,
  freightOpportunities,
  type QuoteOpportunity, type QuoteOutcomeStatus, type QuoteCustomer, type QuoteRep,
  type QuoteCarrier, type QuoteLaneGroup, type QuoteOutcomeReason, type QuoteSavedView,
  type InsertFreightOpportunity,
} from "@shared/schema";
import { UNKNOWN_CUSTOMER_NAME, classifyPartyType } from "./customerNameResolver";
import { isCustomerFacingQuoteRep } from "@shared/quoteOpportunitiesRoles";
import { users } from "@shared/schema";
import { learnFromReassign } from "./quoteSenderMappings";
import type { QuotePartyType } from "@shared/schema";
import { getStaleQuoteFollowUps } from "./staleQuoteFollowup";
import { getActivePatternAlertsForOrg } from "./quotePatternShift";
import { computeQuoteSla } from "@shared/quoteSla";
import { normalizeEquipmentType } from "@shared/laneFormatters";
import { readFileSync } from "fs";
import { join } from "path";
import { getCityCoords, haversineDistanceMiles } from "../cityCoordinates";
import { cityToKma } from "../kmaMapping";
import {
  getLaneMarket, getLaneTraffic, getLaneCarriers, getCorridorPattern,
  type LaneMarket, type LaneTraffic, type CarrierOutreachItem, type CorridorPattern,
} from "./spotMarketData";

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
  // Task #615 — historical "Unknown — needs review" quick filter. Kept on
  // the type purely so old saved-view rows that still carry the flag are
  // accepted by the route validator; the snapshot/list chokepoint always
  // hides unknown rows now (alongside carriers) so the flag is a no-op.
  needsReviewOnly?: boolean;
};

export type EnrichedQuote = QuoteOpportunity & {
  customerName: string;
  repName: string;
  carrierName: string | null;
  outcomeReasonLabel: string | null;
  // Task #526 — populated for source="email" rows so the table can deep-link
  // to the source thread in the Conversations tab. Both null when the email
  // can't be resolved (e.g., purged) or for non-email quotes.
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  // Customer Quotes #2 — server-computed SLA snapshot. Always present
  // (`state: "na"` for non-pending rows) so client code never has to guard.
  slaState: import("@shared/quoteSla").QuoteSlaState;
  minutesSinceRequest: number;
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
  // Task #597 — hard no-op in production regardless of any env flag, so a
  // mis-set environment variable can never re-introduce demo rows on a live
  // tenant. Routes also no longer call ensureQuoteSeed; this is the
  // belt-and-suspenders guard for the helper itself.
  if (process.env.NODE_ENV === "production") return false;
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
    // Synthetic SONAR benchmark: hovers ±6% off a stable lane+equipment base so
    // demo quotes naturally distribute across price-position bins.
    const benchBase = baseRate * distFactor;
    const sonarBenchmark = Math.round(benchBase * (0.96 + rand() * 0.08));

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
      sonarBenchmark: String(sonarBenchmark),
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

// Task #526 — purge demo seed rows that may have leaked into a live org. The
// seeded rows have stable signatures (customer/carrier/lane-group names, rep
// emails @example.com, and source_reference matching `(EMAIL|TMS|CRM|MANUAL)-1###`).
// Idempotent and safe to re-run: targets only the demo signature, and the
// child quote_events cascade away with their parent opportunities.
const DEMO_CUSTOMER_NAMES = [
  "Aurora Foods", "Northwind Industrial", "Cascade Beverage Co",
  "Summit Building Products", "Harbor Retail Group", "Pioneer Auto Parts",
] as const;
const DEMO_CARRIER_NAMES = [
  "Granite Logistics", "Skyway Carriers", "Ironwood Freight",
  "BlueRidge Transport", "Cobalt Trucking", "Highmark Lines", "Greenfield Express",
] as const;
const DEMO_LANE_GROUP_NAMES = [
  "Midwest → Southeast", "PNW → California", "Texas → Northeast",
  "Southeast → Midwest", "California → Mountain",
] as const;
const DEMO_REP_EMAILS = [
  "jamie@example.com", "riley@example.com", "morgan@example.com",
  "sam@example.com", "avery@example.com",
] as const;
const DEMO_OUTCOME_REASON_CODES = [
  "won_competitive", "won_capacity", "won_relationship",
  "lost_price_high", "lost_service_concerns", "lost_timing", "lost_incumbent_won",
  "no_response", "expired",
] as const;
const DEMO_SOURCE_REF_PATTERN = /^(EMAIL|TMS|CRM|MANUAL)-1\d{3}$/;

export type DemoSeedPurgeSummary = {
  scope: "org" | "all";
  organizationId: string | null;
  opportunitiesDeleted: number;
  customersDeleted: number;
  carriersDeleted: number;
  repsDeleted: number;
  laneGroupsDeleted: number;
  outcomeReasonsDeleted: number;
};

// Build a SQL fragment of comma-separated string literals safe for inline IN ()
// expansion. Inputs are compile-time constants (DEMO_*_NAMES) so SQL injection
// is not a concern, but we still use sql.join with parameter binding so values
// are passed via the driver rather than concatenated.
function inListLiteral(values: readonly string[]) {
  return sql.join(values.map((v) => sql`${v}`), sql`, `);
}

export async function purgeDemoSeed(orgId?: string): Promise<DemoSeedPurgeSummary> {
  // 1) Delete opportunities matching the demo source_reference signature
  //    (cascades quote_events). This is the only "by-signature" delete; the
  //    dim tables below are deleted only when (a) name/code/email matches
  //    a known demo value AND (b) the row is orphaned with no remaining
  //    opportunity references. That orphan check protects any legitimate
  //    real-world rows that happen to share a name/code with seeded data
  //    (especially generic outcome reason codes like "no_response" or
  //    "expired") from being deleted alongside the demo rows.
  const oppsRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_opportunities
     WHERE source_reference ~ ${DEMO_SOURCE_REF_PATTERN.source}
       ${orgId ? sql`AND organization_id = ${orgId}` : sql``}
    RETURNING id
  `);
  const opportunitiesDeleted = oppsRes.rows.length;

  // 2) Drop now-orphaned demo customers.
  const custRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_customers c
     WHERE c.name IN (${inListLiteral(DEMO_CUSTOMER_NAMES)})
       ${orgId ? sql`AND c.organization_id = ${orgId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM quote_opportunities o WHERE o.customer_id = c.id)
    RETURNING c.id
  `);
  const customersDeleted = custRes.rows.length;

  // 3) Drop now-orphaned demo carriers (carrier_id is SET NULL on opps).
  const carrierRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_carriers c
     WHERE c.name IN (${inListLiteral(DEMO_CARRIER_NAMES)})
       ${orgId ? sql`AND c.organization_id = ${orgId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM quote_opportunities o WHERE o.carrier_id = c.id)
    RETURNING c.id
  `);
  const carriersDeleted = carrierRes.rows.length;

  // 4) Drop now-orphaned demo reps (rep_id is SET NULL on opps).
  const repRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_reps r
     WHERE r.email IN (${inListLiteral(DEMO_REP_EMAILS)})
       ${orgId ? sql`AND r.organization_id = ${orgId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM quote_opportunities o WHERE o.rep_id = r.id)
    RETURNING r.id
  `);
  const repsDeleted = repRes.rows.length;

  // 5) Drop now-orphaned demo lane groups (lane_group_id is SET NULL on opps).
  const lgRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_lane_groups g
     WHERE g.name IN (${inListLiteral(DEMO_LANE_GROUP_NAMES)})
       ${orgId ? sql`AND g.organization_id = ${orgId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM quote_opportunities o WHERE o.lane_group_id = g.id)
    RETURNING g.id
  `);
  const laneGroupsDeleted = lgRes.rows.length;

  // 6) Drop now-orphaned demo outcome reasons (outcome_reason_id is SET NULL).
  //    The orphan guard is critical here because codes like "expired" and
  //    "no_response" are generic enough that a real org may legitimately
  //    use them on real opportunities — those rows must survive.
  const reasonRes = await db.execute<{ id: string }>(sql`
    DELETE FROM quote_outcome_reasons r
     WHERE r.code IN (${inListLiteral(DEMO_OUTCOME_REASON_CODES)})
       ${orgId ? sql`AND r.organization_id = ${orgId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM quote_opportunities o WHERE o.outcome_reason_id = r.id)
    RETURNING r.id
  `);
  const outcomeReasonsDeleted = reasonRes.rows.length;

  return {
    scope: orgId ? "org" : "all",
    organizationId: orgId ?? null,
    opportunitiesDeleted,
    customersDeleted,
    carriersDeleted,
    repsDeleted,
    laneGroupsDeleted,
    outcomeReasonsDeleted,
  };
}

/**
 * Task #584 — collect the customer IDs in the org that represent the shared
 * "Unknown — needs review" bucket. We match by name (case-insensitive) rather
 * than a hard-coded id because seeded/legacy orgs may have more than one
 * historical bucket row that needs draining.
 */
function unknownCustomerIdsFromMap(customerMap: Map<string, QuoteCustomer>): Set<string> {
  const target = UNKNOWN_CUSTOMER_NAME.toLowerCase();
  const out = new Set<string>();
  customerMap.forEach((c, id) => {
    if (c.name.trim().toLowerCase() === target) out.add(id);
  });
  return out;
}

function applyFilters(
  rows: QuoteOpportunity[],
  f: QuoteFilters,
  // Task #615 — single chokepoint for the customer-only rule. Any customer
  // whose id is in this set has `partyType !== "customer"` (carrier OR
  // unknown OR missing) and is filtered out of every aggregate driven by
  // this helper (KPIs, list, charts, taxonomy, attractiveness, CSV export).
  // The flag is hard-wired ON: there is no opt-in to surface non-customer
  // rows on the Quote Opportunities feed.
  nonCustomerCustomerIds?: Set<string>,
): QuoteOpportunity[] {
  return rows.filter((r) => {
    if (nonCustomerCustomerIds && nonCustomerCustomerIds.has(r.customerId)) return false;
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
    // Task #615 — `needsReviewOnly` is intentionally ignored. The chokepoint
    // above already removes every unknown-bucket row, so the unknown-only
    // quick-filter would always produce an empty set. Old saved-view rows
    // that still carry the flag therefore behave like an unfiltered view of
    // the (already-customer-only) result set.
    if (f.laneSearch) {
      const lane = `${r.originCity},${r.originState} ${r.destCity},${r.destState}`.toLowerCase();
      const tokens = f.laneSearch.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.every(t => lane.includes(t))) return false;
    }
    return true;
  });
}

/**
 * Task #615 — derive the set of `quote_customers.id` values that the
 * Quote Opportunities feed must NEVER surface. Anything not explicitly
 * classified as `partyType === "customer"` (i.e. carrier OR unknown OR
 * a row missing a partyType for any reason) lands in here. Returns an
 * empty set when nothing in the org needs filtering so callers can pass
 * it unconditionally.
 */
function nonCustomerCustomerIdsFromMap(customerMap: Map<string, QuoteCustomer>): Set<string> {
  const out = new Set<string>();
  customerMap.forEach((c, id) => {
    if (c.partyType !== "customer") out.add(id);
  });
  return out;
}

/**
 * Task #597 — best-effort backfill that classifies every `quote_customers`
 * row in the org whose `partyType` is still "unknown" AND `partyTypeManual`
 * is false (so we never overwrite a rep's manual override). Match signal:
 *   1. Case-insensitive name match against `quote_carriers` for the org.
 *   2. Carrier-suffix tokens in the name (Freight, Logistics, Trucking, …).
 * A row whose name has no carrier signal is classified as "customer" so
 * the dashboard can stop guessing on every snapshot. Idempotent: a second
 * run is a no-op.
 *
 * Memoized per-org (60 s) so back-to-back snapshot/list/exportCsv calls
 * don't pay the cost on every request. Callers that want a fresh classify
 * can call `clearPartyTypeBackfillCache(orgId)`.
 */
const PARTY_TYPE_BACKFILL_CACHE = new Map<string, number>();
const PARTY_TYPE_BACKFILL_TTL_MS = 60 * 1000;

export function clearPartyTypeBackfillCache(orgId?: string): void {
  if (orgId) PARTY_TYPE_BACKFILL_CACHE.delete(orgId);
  else PARTY_TYPE_BACKFILL_CACHE.clear();
}

/**
 * Task #597 — pull every distinct email domain from the org's carriers
 * catalog (primary + backup emails) so the classifier can recognize
 * carriers whose company names lack a carrier-suffix token. Returns a
 * lowercased set; an empty set when the org has no carrier emails on file.
 */
async function loadKnownCarrierDomains(orgId: string): Promise<Set<string>> {
  const rows = await db.select({
    primary: carriersCatalog.primaryEmail,
    backup: carriersCatalog.backupEmail,
  }).from(carriersCatalog).where(eq(carriersCatalog.orgId, orgId));
  const domains = new Set<string>();
  for (const r of rows) {
    for (const email of [r.primary, r.backup]) {
      if (!email) continue;
      const at = email.lastIndexOf("@");
      if (at < 0) continue;
      const dom = email.slice(at + 1).trim().toLowerCase();
      if (dom) domains.add(dom);
    }
  }
  return domains;
}

export async function backfillCustomerPartyTypes(orgId: string): Promise<{ scanned: number; classified: number }> {
  const candidates = await db.select().from(quoteCustomers).where(and(
    eq(quoteCustomers.organizationId, orgId),
    eq(quoteCustomers.partyTypeManual, false),
    eq(quoteCustomers.partyType, "unknown"),
  ));
  if (candidates.length === 0) return { scanned: 0, classified: 0 };

  const carriers = await db.select({ name: quoteCarriers.name }).from(quoteCarriers)
    .where(eq(quoteCarriers.organizationId, orgId));
  const knownCarrierNames = new Set(carriers.map(c => c.name.trim().toLowerCase()).filter(Boolean));
  // Task #597 — also include the org-wide carrier email-domain catalog so
  // brokers/carriers whose names don't include a carrier-suffix token are
  // still classified correctly when they sent quotes from a known domain.
  const knownCarrierDomains = await loadKnownCarrierDomains(orgId);

  let classified = 0;
  for (const c of candidates) {
    const t = classifyPartyType({ name: c.name, knownCarrierNames, knownCarrierDomains });
    if (t === "unknown") continue;
    await db.update(quoteCustomers)
      .set({ partyType: t })
      .where(and(eq(quoteCustomers.id, c.id), eq(quoteCustomers.partyTypeManual, false)));
    classified += 1;
  }
  return { scanned: candidates.length, classified };
}

/**
 * Run `backfillCustomerPartyTypes` lazily and only once per TTL window.
 * Callers should fire-and-forget; failures are logged and never bubble up
 * because the caller's primary work (snapshot/list) must always succeed.
 */
function maybeBackfillPartyTypesAsync(orgId: string): void {
  const last = PARTY_TYPE_BACKFILL_CACHE.get(orgId) ?? 0;
  const now = Date.now();
  if (now - last < PARTY_TYPE_BACKFILL_TTL_MS) return;
  PARTY_TYPE_BACKFILL_CACHE.set(orgId, now);
  void backfillCustomerPartyTypes(orgId).catch(err => {
    console.warn("[customer-quotes] partyType backfill failed:", err);
    // Re-arm so the next request retries instead of being throttled.
    PARTY_TYPE_BACKFILL_CACHE.delete(orgId);
  });
}

/**
 * Task #597 — manual override hook used by the per-row "Mark customer" /
 * "Mark carrier" / "Mark unknown" buttons in the drawer. Always sets
 * `partyTypeManual = true` so background classifiers leave this row alone
 * forever. Returns the updated row or null when no row matched.
 */
export async function setCustomerPartyType(
  orgId: string,
  customerId: string,
  partyType: QuotePartyType,
): Promise<QuoteCustomer | null> {
  const [row] = await db.update(quoteCustomers)
    .set({ partyType, partyTypeManual: true })
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, customerId)))
    .returning();
  return row ?? null;
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
  opts: { now?: number } = {},
): EnrichedQuote[] {
  const now = opts.now ?? Date.now();
  return rows.map(r => {
    const sla = computeQuoteSla(r.requestDate, r.outcomeStatus, { now });
    return {
      ...r,
      customerName: customerMap.get(r.customerId)?.name ?? "—",
      repName: r.repId ? repMap.get(r.repId)?.name ?? "—" : "—",
      carrierName: r.carrierId ? carrierMap.get(r.carrierId)?.name ?? null : null,
      outcomeReasonLabel: r.outcomeReasonId ? reasonMap.get(r.outcomeReasonId)?.label ?? null : null,
      slaState: sla.state,
      minutesSinceRequest: sla.minutesSinceRequest,
    };
  });
}

async function loadContext(orgId: string) {
  // Task #714 — left-join `users` so we can hide reps whose linked user is
  // a non-customer-facing role (logistics_manager, logistics_coordinator,
  // generic "sales", etc.) from the Quote Opportunities pickers and the
  // funnel rep performance breakdown. Reps with NULL `user_id` (legacy /
  // email-signature only) are kept since they pre-date the user system
  // and removing them would erase historical attribution.
  const [customers, repsJoined, reasons, laneGroups, carriers] = await Promise.all([
    db.select().from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)).orderBy(asc(quoteCustomers.name)),
    db
      .select({
        id: quoteReps.id,
        organizationId: quoteReps.organizationId,
        userId: quoteReps.userId,
        name: quoteReps.name,
        email: quoteReps.email,
        linkedUserRole: users.role,
      })
      .from(quoteReps)
      .leftJoin(users, eq(users.id, quoteReps.userId))
      .where(eq(quoteReps.organizationId, orgId))
      .orderBy(asc(quoteReps.name)),
    db.select().from(quoteOutcomeReasons).where(eq(quoteOutcomeReasons.organizationId, orgId)),
    db.select().from(quoteLaneGroups).where(eq(quoteLaneGroups.organizationId, orgId)),
    db.select().from(quoteCarriers).where(eq(quoteCarriers.organizationId, orgId)),
  ]);
  // `allReps` powers `repMap` so individual quote rows can still resolve a
  // rep's display name even when that rep is hidden from the dropdowns.
  // `reps` is the public-facing list returned to the client (snapshot.reps)
  // and is filtered to customer-facing reps only.
  const allReps: QuoteRep[] = repsJoined.map(({ linkedUserRole: _r, ...rest }) => rest);
  const customerFacingReps: QuoteRep[] = repsJoined
    .filter(r => isCustomerFacingQuoteRep(r.linkedUserRole))
    .map(({ linkedUserRole: _r, ...rest }) => rest);
  const customerFacingRepIds = new Set<string>(customerFacingReps.map(r => r.id));
  return {
    customers,
    // Public rep list (snapshot.reps consumes this directly).
    reps: customerFacingReps,
    reasons, laneGroups, carriers,
    customerMap: new Map(customers.map(c => [c.id, c])),
    // repMap retains every rep so name lookups in list rows / drawers /
    // funnel-bucket labels still resolve for legacy / hidden rows.
    repMap: new Map(allReps.map(r => [r.id, r])),
    reasonMap: new Map(reasons.map(r => [r.id, r])),
    carrierMap: new Map(carriers.map(c => [c.id, c])),
    // Set used by the funnel performers aggregation to drop quotes
    // attributed to a non-customer-facing rep from the best/worst rep
    // ranking. The underlying quote rows are unaffected.
    customerFacingRepIds,
  };
}

export async function listQuotes(orgId: string, filters: QuoteFilters, sortKey: ListSortKey, sortDir: "asc" | "desc", offset: number, limit: number): Promise<ListResult> {
  // Task #597 — fire-and-forget classifier so unknown rows are graded into
  // customer/carrier without blocking the response.
  maybeBackfillPartyTypesAsync(orgId);
  const ctx = await loadContext(orgId);
  const all = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));
  const nonCustomerIds = nonCustomerCustomerIdsFromMap(ctx.customerMap);
  const filtered = applyFilters(all, filters, nonCustomerIds);
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

  const page = enriched.slice(offset, offset + limit);
  await attachSourceThreads(orgId, page);
  return {
    rows: page,
    total: enriched.length,
    offset, limit,
  };
}

/**
 * Task #526 — batch-resolve source thread / message IDs for the visible page
 * of email-sourced quotes so the Quote Opportunities table can render a
 * "Open in Conversations" deep-link in the source cell. Mutates `rows` in
 * place and is a no-op when the page contains no email-sourced rows.
 *
 * The lookup mirrors `loadSourceMessage` (providerMessageId first, then
 * internal id), but in two batched queries instead of N per-row queries.
 */
async function attachSourceThreads(orgId: string, rows: EnrichedQuote[]): Promise<void> {
  const emailRows = rows.filter(r => r.source === "email" && r.sourceReference);
  if (emailRows.length === 0) return;
  const refs = Array.from(new Set(emailRows.map(r => r.sourceReference!).filter(Boolean)));
  if (refs.length === 0) return;
  const inList = sql.join(refs.map(v => sql`${v}`), sql`, `);
  const matches = await db.execute<{
    id: string;
    thread_id: string | null;
    provider_message_id: string | null;
  }>(sql`
    SELECT id, thread_id, provider_message_id
      FROM email_messages
     WHERE org_id = ${orgId}
       AND (provider_message_id IN (${inList}) OR id IN (${inList}))
  `);
  const byProvider = new Map<string, { id: string; threadId: string | null }>();
  const byId = new Map<string, { id: string; threadId: string | null }>();
  for (const m of matches.rows) {
    if (m.provider_message_id) byProvider.set(m.provider_message_id, { id: m.id, threadId: m.thread_id });
    byId.set(m.id, { id: m.id, threadId: m.thread_id });
  }
  for (const r of emailRows) {
    const ref = r.sourceReference!;
    const hit = byProvider.get(ref) ?? byId.get(ref) ?? null;
    if (hit) {
      r.sourceMessageId = hit.id;
      r.sourceThreadId = hit.threadId;
    } else {
      r.sourceMessageId = null;
      r.sourceThreadId = null;
    }
  }
}

/**
 * Customer Quotes #2 — Action Queue.
 *
 * Returns the categories of pending work that the rep should prioritise
 * above everything else, each capped at `limit` (default 5):
 *   - slaBreaching:  pending quotes whose age >= SLA threshold
 *   - expiringToday: pending quotes whose validThrough is within 24h
 *
 * Task #615 — pending rows whose customer is anything other than a
 * confirmed `partyType === "customer"` (carrier OR unknown) are dropped
 * before the buckets are computed, matching the customer-only contract
 * of the surrounding Quote Opportunities page. The historical
 * "needs review" bucket (which surfaced unknown-bucket rows for triage)
 * has been retired; that workflow now lives outside this view.
 *
 * Returned rows use the same EnrichedQuote shape as the main list so
 * the client can reuse all existing row-renderers / drawer plumbing.
 */
export async function getActionQueue(
  orgId: string,
  opts: { limit?: number; now?: number } = {},
): Promise<{
  slaBreaching: EnrichedQuote[];
  expiringToday: EnrichedQuote[];
}> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 5));
  const now = opts.now ?? Date.now();
  const ctx = await loadContext(orgId);
  const all = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));

  const nonCustomerIds = nonCustomerCustomerIdsFromMap(ctx.customerMap);

  const pending = all.filter(r =>
    r.outcomeStatus === "pending" && !nonCustomerIds.has(r.customerId)
  );

  const enriched = enrich(pending, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, { now });

  const slaBreaching = enriched
    .filter(r => r.slaState === "breached")
    .sort((a, b) => a.requestDate.getTime() - b.requestDate.getTime())
    .slice(0, limit);

  const dayMs = 24 * 60 * 60 * 1000;
  const expiringToday = enriched
    .filter(r => r.validThrough && r.validThrough.getTime() - now <= dayMs && r.validThrough.getTime() >= now)
    .sort((a, b) => (a.validThrough!.getTime() - b.validThrough!.getTime()))
    .slice(0, limit);

  // Cheaper to attach source thread refs once across the union than twice.
  const merged = Array.from(new Map(
    [...slaBreaching, ...expiringToday].map(r => [r.id, r] as const),
  ).values());
  await attachSourceThreads(orgId, merged);

  return { slaBreaching, expiringToday };
}

/**
 * Customer Quotes #2 — bulk reassign Needs-Review quotes to a real
 * customer. Defensive against accidental misuse: a quote is skipped
 * (not silently overwritten) if its current customer is NOT in the
 * shared "Unknown — needs review" bucket. Returns the per-id outcome
 * so the UI can surface "23 reassigned, 2 skipped".
 */
export async function bulkReassignCustomerForQuotes(
  orgId: string,
  quoteIds: string[],
  targetCustomerId: string,
): Promise<{ updated: number; skipped: string[]; reassignedIds: string[] }> {
  if (!quoteIds.length) return { updated: 0, skipped: [], reassignedIds: [] };

  // Confirm the target exists in the same org. Refuse otherwise.
  const [target] = await db.select().from(quoteCustomers)
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, targetCustomerId)))
    .limit(1);
  if (!target) {
    throw new Error("Target customer not found in this organization");
  }
  if (target.name === UNKNOWN_CUSTOMER_NAME) {
    // Reassigning into the unknown bucket is the inverse of the feature
    // and can hide bad data. Refuse.
    throw new Error("Cannot reassign into the Unknown bucket");
  }

  const ctx = await loadContext(orgId);
  const unknownIds = unknownCustomerIdsFromMap(ctx.customerMap);

  const rows = await db.select().from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      inArray(quoteOpportunities.id, quoteIds),
    ));

  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const id of quoteIds) {
    const r = rows.find(x => x.id === id);
    if (!r) { skipped.push(id); continue; }
    if (!unknownIds.has(r.customerId)) { skipped.push(id); continue; }
    eligible.push(id);
  }

  if (eligible.length > 0) {
    // Defensive write predicate: even though we pre-filtered by Unknown
    // bucket, a concurrent classifier run could have flipped a row to a
    // real customer between the read above and this UPDATE. Re-asserting
    // `customerId IN unknownIds` in the WHERE makes the invariant hold
    // at write time, so we never silently overwrite an already-classified
    // row. Returning the affected ids lets us reconcile with `eligible`
    // and report the real count.
    const unknownIdList = Array.from(unknownIds);
    if (unknownIdList.length === 0) {
      // No unknown buckets exist (yet) — nothing is reassignable.
      return { updated: 0, skipped: [...skipped, ...eligible], reassignedIds: [] };
    }
    const written = await db.update(quoteOpportunities)
      .set({ customerId: targetCustomerId })
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        inArray(quoteOpportunities.id, eligible),
        inArray(quoteOpportunities.customerId, unknownIdList),
      ))
      .returning({ id: quoteOpportunities.id, sourceReference: quoteOpportunities.sourceReference });
    const writtenIds = new Set(written.map(w => w.id));
    const racedSkips = eligible.filter(id => !writtenIds.has(id));

    // Customer Quotes #3 — sender-domain learning. For every row that
    // actually moved out of Unknown into the chosen target, record the
    // sender→customer mapping so future inbound emails skip the
    // Unknown bucket. Run sequentially (not Promise.all) to keep DB
    // load predictable for large batches; individual failures are
    // swallowed by `learnFromReassign` and logged.
    for (const row of written) {
      await learnFromReassign(orgId, row.sourceReference, targetCustomerId);
    }

    return {
      updated: written.length,
      skipped: [...skipped, ...racedSkips],
      reassignedIds: written.map(w => w.id),
    };
  }

  return { updated: 0, skipped, reassignedIds: [] };
}

/**
 * Customer Quotes #2 — bulk-flip outcome status. Currently used by the
 * "Mark ignored" bulk action so reps can clear out spam without opening
 * each row. Org-scoped; rejects unknown statuses.
 */
export async function bulkSetQuoteStatus(
  orgId: string,
  quoteIds: string[],
  status: "ignored" | "pending",
): Promise<{ updated: number }> {
  if (!quoteIds.length) return { updated: 0 };
  const result = await db.update(quoteOpportunities)
    .set({ outcomeStatus: status })
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      inArray(quoteOpportunities.id, quoteIds),
    ))
    .returning({ id: quoteOpportunities.id });
  return { updated: result.length };
}

export async function getSnapshot(orgId: string, filters: QuoteFilters): Promise<Snapshot> {
  // Task #597 — see listQuotes; lazy classifier keeps the snapshot honest
  // without paying the cost on every request.
  maybeBackfillPartyTypesAsync(orgId);
  const ctx = await loadContext(orgId);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId))
    .orderBy(desc(quoteOpportunities.requestDate));

  const nonCustomerIds = nonCustomerCustomerIdsFromMap(ctx.customerMap);
  const filtered = applyFilters(allOpps, filters, nonCustomerIds);
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
    // Task #615 — Quote Opportunities is customer-only; never surface
    // rising-volume alerts for non-customer rows (carriers OR unknown).
    if (nonCustomerIds.has(c.id)) continue;
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
  // Task #615 — Quote Opportunities is customer-only; drop any stale-follow-up
  // pointing at a non-customer row so widgets stay consistent with the table.
  if (nonCustomerIds.size > 0) {
    staleFiltered = staleFiltered.filter(s => !nonCustomerIds.has(s.customerId));
  }
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
    kpis: {
      total, won: won.length, lost: lost.length, winRate, avgQuoted, avgCarrierCost,
      avgMarginDollar, avgMarginPct, avgResponseTime, pending: pending.length, expiringSoon,
      trend,
    },
    customers: ctx.customers, reps: ctx.reps, reasons: ctx.reasons, laneGroups: ctx.laneGroups, carriers: ctx.carriers,
    customerPerformance, taxonomy: taxonomyCounts,
    validityWindow: { expiringList, agingBuckets, staleCount, activeCount, expiredCount },
    laneVariance, attractiveness,
    staleFollowUps,
    charts: { trend: trendBuckets, winRateByCustomer, marginByCustomer, topLanes, highVolLowWin },
    alerts,
  };
}

export type QuoteSourceMessage = {
  messageId: string;
  threadId: string | null;
  providerMessageId: string | null;
  subject: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
};

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
  // Task #477 — populated when this quote auto-created a Lane Work Queue lane.
  lwqLaneId: string | null;
  // Task #526 — when source = "email", expose the underlying email_messages
  // row (looked up by sourceReference) so the drawer can deep-link to the
  // Conversations tab on the right thread.
  sourceMessage: QuoteSourceMessage | null;
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
  const lwqLane = await getLwqLaneForQuote(orgId, quoteId);
  const sourceMessage = await loadSourceMessage(orgId, opp);
  return {
    opp, events, customer, rep, carrier, reason,
    relatedSameLane: sameLane.filter(r => r.id !== quoteId),
    relatedSameCustomer: sameCustomer.filter(r => r.id !== quoteId),
    relatedSameLaneGroup: sameLaneGroup.filter(r => r.id !== quoteId && r.originCity !== opp.originCity),
    lwqLaneId: lwqLane?.laneId ?? null,
    sourceMessage,
  };
}

/**
 * Resolve the email_messages row that produced this quote so the drawer can
 * deep-link to the Conversations tab. The sourceReference is set by
 * `ingestQuoteFromEmail` to providerMessageId (preferred) or the internal
 * id, so we try both lookups in order. Returns null for non-email quotes
 * or when the underlying message has been purged.
 */
async function loadSourceMessage(
  orgId: string,
  opp: QuoteOpportunity,
): Promise<QuoteSourceMessage | null> {
  if (opp.source !== "email") return null;
  const ref = opp.sourceReference;
  if (!ref) return null;
  const byProvider = await db.select().from(emailMessages).where(and(
    eq(emailMessages.orgId, orgId),
    eq(emailMessages.providerMessageId, ref),
  )).limit(1);
  let msg = byProvider[0] ?? null;
  if (!msg) {
    const byId = await db.select().from(emailMessages).where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.id, ref),
    )).limit(1);
    msg = byId[0] ?? null;
  }
  if (!msg) return null;
  return {
    messageId: msg.id,
    threadId: msg.threadId ?? null,
    providerMessageId: msg.providerMessageId ?? null,
    subject: msg.subject ?? null,
    fromEmail: msg.fromEmail ?? null,
    receivedAt: (msg.providerSentAt ?? msg.createdAt ?? null) instanceof Date
      ? (msg.providerSentAt ?? msg.createdAt)!.toISOString()
      : null,
  };
}

// ── Pricing Intelligence (Task #479) ────────────────────────────────────────
//
// Given a customer + lane + equipment, surface the historical quote dataset
// that is relevant for pricing the next request:
//
//   - Recent N decided quotes from the same customer on the same lane (or
//     same lane group as a wider fallback).
//   - Win-rate curve binned by price-position vs the SONAR benchmark snapshot
//     stored on each quote at the time it was created. Bins:
//       <-5%, -5..-3, -3..-1, -1..+1, +1..+3, +3..+5, >+5%
//   - A suggested price range derived from the bin with the highest win-rate
//     among bins with a sample size >= 2, expressed back into $/load using
//     the live SONAR benchmark for the lane (or the most recent stored
//     benchmark if Sonar is unavailable).
//
// Empty-state safe:
//   - If sample size (decided quotes) < 5 we return the raw history with
//     `suggestion = null` and `confidence = "insufficient_history"`.
//   - If sample size < 12 we still return a suggestion but mark
//     `confidence = "low"` so the UI can downplay it.

export type PricingPriceBin = {
  label: string;
  /** Inclusive lower-bound of price position vs SONAR (decimal, e.g. -0.05). */
  lo: number;
  /** Exclusive upper-bound. Use Infinity for the topmost bin. */
  hi: number;
  total: number;
  won: number;
  winRate: number;
};

export type PricingSuggestion = {
  /** Suggested low/high $/load. */
  low: number;
  high: number;
  /** Center bin's price-position lower/upper bounds (decimal). */
  positionLow: number;
  positionHigh: number;
  binWinRate: number;
  binSample: number;
  rationale: string;
};

export type PricingHistoryRow = {
  id: string;
  requestDate: string;
  quotedAmount: number;
  sonarBenchmark: number | null;
  pricePosition: number | null;
  outcomeStatus: string;
  outcomeLabel: string;
  carrierPaid: number | null;
  marginDollar: number | null;
  marginPct: number | null;
  scope: "same_lane" | "same_lane_group";
};

export type PricingIntelligence = {
  customerId: string;
  customerName: string | null;
  lane: { originCity: string; originState: string; destCity: string; destState: string };
  equipment: string | null;
  scope: "same_lane" | "same_lane_group" | "none";
  totalConsidered: number;
  decidedSample: number;
  sonarBenchmark: number | null;
  benchmarkSource: "stored_recent" | "stored_avg" | "similar_lanes" | "none";
  bins: PricingPriceBin[];
  history: PricingHistoryRow[];
  suggestion: PricingSuggestion | null;
  confidence: "high" | "medium" | "low" | "insufficient_history" | "no_benchmark";
  message: string;
};

export type PricingIntelInput = {
  customerId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment?: string;
  laneGroupId?: string;
};

const PRICE_BINS: { label: string; lo: number; hi: number }[] = [
  { label: "<-5%",   lo: -Infinity, hi: -0.05 },
  { label: "-5..-3%", lo: -0.05,    hi: -0.03 },
  { label: "-3..-1%", lo: -0.03,    hi: -0.01 },
  { label: "-1..+1%", lo: -0.01,    hi:  0.01 },
  { label: "+1..+3%", lo:  0.01,    hi:  0.03 },
  { label: "+3..+5%", lo:  0.03,    hi:  0.05 },
  { label: ">+5%",   lo:  0.05,     hi:  Infinity },
];

function ciEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function getPricingIntelligence(
  orgId: string, input: PricingIntelInput,
): Promise<PricingIntelligence> {
  const ctx = await loadContext(orgId);
  const customer = ctx.customerMap.get(input.customerId) ?? null;
  const equipment = input.equipment ?? null;

  // Pull the customer's full quote history once and partition.
  const allCustomer = await db.select().from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.customerId, input.customerId),
    ))
    .orderBy(desc(quoteOpportunities.requestDate));

  const eqMatch = (r: QuoteOpportunity): boolean =>
    !equipment || ciEq(r.equipment, equipment);

  const sameLane = allCustomer.filter(r =>
    ciEq(r.originCity, input.originCity) &&
    ciEq(r.originState, input.originState) &&
    ciEq(r.destCity, input.destCity) &&
    ciEq(r.destState, input.destState) &&
    eqMatch(r),
  );

  const sameLaneGroup = input.laneGroupId
    ? allCustomer.filter(r => r.laneGroupId === input.laneGroupId && eqMatch(r))
    : [];

  // Prefer same-lane history; fall back to same-lane-group when sparse.
  let scope: "same_lane" | "same_lane_group" | "none" = "none";
  let pool: QuoteOpportunity[] = [];
  if (sameLane.length >= 5) {
    pool = sameLane;
    scope = "same_lane";
  } else if (sameLane.length + sameLaneGroup.length >= 5) {
    // Merge & dedupe — same-lane rows are a subset of same-lane-group when
    // laneGroupId matches, but we use the union to widen the sample.
    const seen = new Set<string>();
    pool = [...sameLane, ...sameLaneGroup].filter(r => {
      if (seen.has(r.id)) return false; seen.add(r.id); return true;
    });
    scope = "same_lane_group";
  } else {
    pool = sameLane.length > 0 ? sameLane : sameLaneGroup;
    scope = sameLane.length > 0 ? "same_lane" : (sameLaneGroup.length > 0 ? "same_lane_group" : "none");
  }

  // Build raw history view (cap at 10 most recent for UI).
  const history: PricingHistoryRow[] = pool.slice(0, 10).map(r => {
    const quoted = num(r.quotedAmount);
    const bench = num(r.sonarBenchmark);
    const paid = num(r.carrierPaid);
    const marginDollar = paid > 0 ? quoted - paid : null;
    const marginPct = paid > 0 && quoted > 0 ? ((quoted - paid) / quoted) * 100 : null;
    return {
      id: r.id,
      requestDate: r.requestDate.toISOString(),
      quotedAmount: quoted,
      sonarBenchmark: bench > 0 ? bench : null,
      pricePosition: bench > 0 && quoted > 0 ? (quoted - bench) / bench : null,
      outcomeStatus: r.outcomeStatus,
      outcomeLabel: ctx.reasonMap.get(r.outcomeReasonId ?? "")?.label ?? "",
      carrierPaid: paid > 0 ? paid : null,
      marginDollar,
      marginPct,
      scope: sameLane.find(s => s.id === r.id) ? "same_lane" : "same_lane_group",
    };
  });

  // Decided sample for win-rate elasticity (won OR lost only — drop
  // pending / no-response / expired so they don't bias the curve).
  const decided = pool.filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus));
  const decidedWithBench = decided.filter(r => num(r.sonarBenchmark) > 0 && num(r.quotedAmount) > 0);

  // Benchmark for the suggestion: prefer the most recent same-lane stored
  // benchmark; fall back to the average across the pool.
  let benchmark: number | null = null;
  let benchmarkSource: PricingIntelligence["benchmarkSource"] = "none";
  const recentBench = sameLane.find(r => num(r.sonarBenchmark) > 0);
  if (recentBench) {
    benchmark = num(recentBench.sonarBenchmark);
    benchmarkSource = "stored_recent";
  } else {
    const benchVals = pool.map(r => num(r.sonarBenchmark)).filter(v => v > 0);
    if (benchVals.length > 0) {
      benchmark = benchVals.reduce((a, b) => a + b, 0) / benchVals.length;
      benchmarkSource = "stored_avg";
    }
  }

  // Bin the decided sample by price-position.
  const bins: PricingPriceBin[] = PRICE_BINS.map(b => ({ label: b.label, lo: b.lo, hi: b.hi, total: 0, won: 0, winRate: 0 }));
  for (const r of decidedWithBench) {
    const pos = (num(r.quotedAmount) - num(r.sonarBenchmark)) / num(r.sonarBenchmark);
    const bin = bins.find(b => pos >= b.lo && pos < b.hi);
    if (!bin) continue;
    bin.total++;
    if (isWon(r.outcomeStatus)) bin.won++;
  }
  for (const b of bins) b.winRate = b.total > 0 ? (b.won / b.total) * 100 : 0;

  // Suggestion logic.
  let suggestion: PricingSuggestion | null = null;
  let confidence: PricingIntelligence["confidence"];
  let message: string;

  if (decided.length < 5) {
    confidence = "insufficient_history";
    message = decided.length === 0
      ? "No prior decided quotes for this customer + lane. No suggested range yet."
      : `Only ${decided.length} prior decided quote${decided.length === 1 ? "" : "s"} — showing raw history without a suggested range.`;
  } else if (!benchmark) {
    confidence = "no_benchmark";
    message = "No SONAR benchmark stored on prior quotes for this lane — cannot compute price-position elasticity.";
  } else {
    // Pick the bin with the best win-rate among bins with sample >= 2 to
    // avoid getting fooled by a single-quote bin. Prefer lower price-position
    // on ties (more competitive).
    const candidates = bins.filter(b => b.total >= 2);
    if (candidates.length === 0) {
      confidence = "low";
      message = `Decided quotes are too thinly distributed across price positions (${decided.length} samples) to recommend a range.`;
    } else {
      const best = [...candidates].sort((a, b) => {
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        return a.lo - b.lo;
      })[0];
      // Build a defensible $/load range. Clamp open-ended bins to ±5%.
      const lo = isFinite(best.lo) ? best.lo : -0.05;
      const hi = isFinite(best.hi) ? best.hi : 0.05;
      const low = Math.round(benchmark * (1 + lo));
      const high = Math.round(benchmark * (1 + hi));
      // Worst (highest-priced) decided bin with samples — used for rationale.
      const worst = [...candidates].sort((a, b) => a.winRate - b.winRate)[0];
      const rationale = worst && worst !== best
        ? `${best.winRate.toFixed(0)}% win rate at SONAR ${best.label} (n=${best.total}), drops to ${worst.winRate.toFixed(0)}% at ${worst.label} (n=${worst.total}).`
        : `${best.winRate.toFixed(0)}% win rate at SONAR ${best.label} (n=${best.total}).`;
      suggestion = {
        low: Math.min(low, high),
        high: Math.max(low, high),
        positionLow: lo,
        positionHigh: hi,
        binWinRate: best.winRate,
        binSample: best.total,
        rationale,
      };
      confidence = decided.length >= 12 ? "high" : "medium";
      message = `Based on ${decided.length} decided quote${decided.length === 1 ? "" : "s"} from ${customer?.name ?? "this customer"}${scope === "same_lane_group" ? " on this lane group" : " on this lane"}.`;
    }
  }

  return {
    customerId: input.customerId,
    customerName: customer?.name ?? null,
    lane: {
      originCity: input.originCity, originState: input.originState,
      destCity: input.destCity, destState: input.destState,
    },
    equipment,
    scope,
    totalConsidered: pool.length,
    decidedSample: decided.length,
    sonarBenchmark: benchmark,
    benchmarkSource,
    bins,
    history,
    suggestion,
    confidence,
    message,
  };
}

export async function createManualQuote(
  orgId: string,
  userId: string,
  data: {
    customerId: string;
    originCity: string; originState: string;
    destCity: string; destState: string;
    equipment: string;
    quotedAmount: number;
    notes?: string;
  },
): Promise<QuoteOpportunity> {
  // Verify customer belongs to org
  const [cust] = await db.select().from(quoteCustomers)
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, data.customerId)))
    .limit(1);
  if (!cust) throw new Error("Customer not found");

  // Try to attach to an existing rep linked to this user (best-effort)
  let repId: string | null = null;
  const [rep] = await db.select().from(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.userId, userId)))
    .limit(1);
  if (rep) repId = rep.id;

  // Best-effort lane group match (region == state)
  let laneGroupId: string | null = null;
  const [lg] = await db.select().from(quoteLaneGroups)
    .where(and(
      eq(quoteLaneGroups.organizationId, orgId),
      eq(quoteLaneGroups.originRegion, data.originState),
      eq(quoteLaneGroups.destRegion, data.destState),
    ))
    .limit(1);
  if (lg) laneGroupId = lg.id;

  const [created] = await db.insert(quoteOpportunities).values({
    organizationId: orgId,
    customerId: data.customerId,
    repId,
    laneGroupId,
    requestDate: new Date(),
    originCity: data.originCity,
    originState: data.originState,
    destCity: data.destCity,
    destState: data.destState,
    equipment: data.equipment,
    quotedAmount: String(data.quotedAmount),
    outcomeStatus: "pending",
    source: "manual",
    sourceReference: `manual-${Date.now()}`,
    notes: data.notes ?? null,
  }).returning();

  await db.insert(quoteEvents).values({
    quoteId: created.id,
    eventType: "created",
    occurredAt: new Date(),
    actor: userId,
    payload: { quotedAmount: String(data.quotedAmount), source: "manual" } as Record<string, unknown>,
  });

  return created;
}

/**
 * Task #584 — create (or fetch a case-insensitively matching existing)
 * `quote_customers` row inside the org. Used by the Customer Quotes
 * dashboard's inline reassign action so reps clearing the
 * "Unknown — needs review" bucket can spin up a brand-new customer
 * record without leaving the row.
 *
 * Idempotent on `lower(name)` — if a customer with the same name (modulo
 * whitespace and case) already exists we return that row unchanged so the
 * dashboard can't fork the same logical customer into two records.
 */
export async function createQuoteCustomer(
  orgId: string,
  rawName: string,
  segment?: string | null,
): Promise<QuoteCustomer> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Customer name is required");
  if (name.length > 120) throw new Error("Customer name is too long");
  const [existing] = await db.select().from(quoteCustomers).where(and(
    eq(quoteCustomers.organizationId, orgId),
    sql`lower(${quoteCustomers.name}) = lower(${name})`,
  )).limit(1);
  if (existing) return existing;
  // Task #597 — auto-classify on insert. The dashboard's reassign popover
  // calls this for net-new "real" customers, so default to `customer` when
  // the name doesn't look like a carrier.
  const partyType = classifyPartyType({ name });
  const [row] = await db.insert(quoteCustomers)
    .values({
      organizationId: orgId,
      name,
      segment: segment && segment.trim() ? segment.trim().slice(0, 80) : null,
      partyType: partyType === "unknown" ? "customer" : partyType,
    })
    .returning();
  return row;
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

export type UpdateQuoteInput = Partial<CreateQuoteInput> & {
  // Task #477 — UI may pass `skipLwqHandoff: true` from the win-outcome dialog
  // to suppress automatic Lane Work Queue lane creation when marking won.
  skipLwqHandoff?: boolean;
};

// Task #477 — Look up the LWQ lane (if any) auto-created for this quote.
export async function getLwqLaneForQuote(orgId: string, quoteId: string): Promise<{ laneId: string } | null> {
  const [row] = await db.select({ id: recurringLanes.id }).from(recurringLanes)
    .where(and(eq(recurringLanes.orgId, orgId), eq(recurringLanes.sourceQuoteId, quoteId)))
    .limit(1);
  return row ? { laneId: row.id } : null;
}

// ── Task #654 — Won-quote → Available Freight same-day handoff ──────────────
//
// When a quote wins and the customer needs cover within the next 72 hours,
// the rep needs the load to land directly in the Available Freight cockpit
// (the spot-dispatch surface) — not in the LWQ recurring-lane backlog. This
// is in addition to the existing LWQ handoff (`createLwqLaneFromWonQuote`),
// which still fires regardless of pickup distance, because some won quotes
// are also the start of a recurring pattern.
//
// The pickup-time proxy is `quote.requestDate` (the schema has no separate
// pickup-date column on quote_opportunities). For real-time customer quotes
// that's the right value: a quote that came in today with a request to ship
// today/tomorrow has requestDate ≈ now+0–24h, which is the exact case this
// handoff is designed to catch.
//
// Org-level toggle: `appSettings` key `auto_won_quote_af_handoff:${orgId}`,
// defaulting to enabled. The setting is shared with the global app_settings
// table — no separate org_settings table is added (matches the convention
// already used by `available_freight_onedrive_url:${orgId}` and other
// org-scoped settings throughout the codebase).

const SAME_DAY_HANDOFF_WINDOW_MS = 72 * 60 * 60 * 1000;

export function autoWonQuoteAfHandoffSettingKey(orgId: string): string {
  return `auto_won_quote_af_handoff:${orgId}`;
}

export async function getAutoWonQuoteAfHandoffEnabled(orgId: string): Promise<boolean> {
  const raw = await storage.getSetting(autoWonQuoteAfHandoffSettingKey(orgId));
  // Default ON per spec — only an explicit "false"/"0" disables.
  if (raw === undefined || raw === null || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

export async function setAutoWonQuoteAfHandoffEnabled(orgId: string, enabled: boolean): Promise<void> {
  await storage.setSetting(autoWonQuoteAfHandoffSettingKey(orgId), enabled ? "true" : "false");
}

/**
 * Won-quote → Available Freight handoff. Idempotent on (orgId, quoteId):
 * keyed off `source_ref->>'quoteId'`, the same field the cockpit reads to
 * render the "From won quote" badge. Re-saving the same won quote updates
 * the existing AF row in place rather than creating a duplicate.
 *
 * Returns `{ id, created }` on success — `created=true` only on the very
 * first hand-off so callers can distinguish a brand-new AF row (worth
 * logging an event/touchpoint) from an idempotent re-save update — and
 * `null` on any skip-or-fail path. Every outcome is logged with a
 * `[customer-quotes] AF handoff …` prefix so the audit trail is grep-able.
 */
async function createFreightOpportunityFromWonQuote(
  orgId: string,
  opp: QuoteOpportunity,
  actorUserId: string | null,
): Promise<{ id: string; created: boolean } | null> {
  try {
    // 1. Org-level setting gate.
    const enabled = await getAutoWonQuoteAfHandoffEnabled(orgId);
    if (!enabled) {
      console.log(`[customer-quotes] AF handoff skipped (disabled) quote=${opp.id} org=${orgId}`);
      return null;
    }

    // 2. Pickup-window check. requestDate is the proxy (see header comment).
    //    Window is the *next* 0–72h: a quote whose pickup is already in the
    //    past (e.g. a stale won quote being re-marked weeks later) is not a
    //    same-day cover candidate and must not generate an AF row.
    const pickupAt = opp.requestDate.getTime();
    const now = Date.now();
    const deltaMs = pickupAt - now;
    if (deltaMs > SAME_DAY_HANDOFF_WINDOW_MS) {
      const hours = Math.round(deltaMs / 3600000);
      console.log(`[customer-quotes] AF handoff skipped (>72h, pickup in ${hours}h) quote=${opp.id}`);
      return null;
    }
    if (deltaMs < 0) {
      const hoursPast = Math.round(-deltaMs / 3600000);
      console.log(`[customer-quotes] AF handoff skipped (pickup ${hoursPast}h in the past) quote=${opp.id}`);
      return null;
    }

    // 3. Resolve company. freight_opportunities.companyId is NOT NULL, so a
    //    customer name with no matching CRM company can't be handed off.
    const [cust] = await db.select().from(quoteCustomers)
      .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, opp.customerId))).limit(1);
    const customerName = cust?.name ?? null;
    if (!customerName) {
      console.log(`[customer-quotes] AF handoff skipped (no customer) quote=${opp.id}`);
      return null;
    }
    let companyId: string;
    const [matched] = await db.select({ id: companies.id }).from(companies)
      .where(and(eq(companies.organizationId, orgId), sql`LOWER(${companies.name}) = LOWER(${customerName})`))
      .limit(1);
    if (matched) {
      companyId = matched.id;
    } else {
      // No CRM company exists for this customer name yet. freight_opportunities
      // requires a non-null companyId, and silently dropping the handoff would
      // mean valid won quotes for new customers never land in the AF cockpit.
      // Auto-create a minimal company tied to this org so the handoff always
      // succeeds for a valid won quote — the rep can enrich the company
      // record later from the CRM.
      const [created] = await db.insert(companies).values({
        organizationId: orgId,
        name: customerName,
      }).returning({ id: companies.id });
      if (!created) {
        console.log(`[customer-quotes] AF handoff skipped (failed to auto-create company "${customerName}") quote=${opp.id}`);
        return null;
      }
      companyId = created.id;
      console.log(`[customer-quotes] AF handoff auto-created company id=${companyId} name="${customerName}" quote=${opp.id}`);
    }

    // Owner: prefer the quote rep's user mapping, like the LWQ handoff.
    let ownerUserId: string | null = null;
    if (opp.repId) {
      const [r] = await db.select({ userId: quoteReps.userId }).from(quoteReps)
        .where(eq(quoteReps.id, opp.repId)).limit(1);
      ownerUserId = r?.userId ?? null;
    }

    const equipment = normalizeEquipmentType(opp.equipment);
    const pickupDay = opp.requestDate.toISOString().slice(0, 10);
    const sourceRef = {
      type: "won_quote" as const,
      quoteId: opp.id,
      buy: opp.carrierPaid,   // null until the rep records carrier cost
      sell: opp.quotedAmount, // the customer-facing rate locked in at win
    };

    // 4. Idempotent upsert. We can't add a unique constraint on a JSONB
    //    expression without a migration, so we serialize concurrent calls
    //    for the same (orgId, quoteId) with a Postgres advisory lock that
    //    auto-releases at transaction commit/rollback. Two parallel PATCH
    //    requests that both try to win the same quote will queue here, and
    //    only the first will see "no existing row" → INSERT; the second
    //    will see the row and UPDATE in place.
    return await db.transaction(async (tx) => {
      // hashtextextended returns a bigint that fits pg_advisory_xact_lock(bigint).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`won_quote_af:${orgId}:${opp.id}`}, 0))`);

      const [existing] = await tx.select({ id: freightOpportunities.id })
        .from(freightOpportunities)
        .where(and(
          eq(freightOpportunities.orgId, orgId),
          sql`${freightOpportunities.sourceRef}->>'quoteId' = ${opp.id}`,
          sql`${freightOpportunities.sourceRef}->>'type' = 'won_quote'`,
        ))
        .limit(1);

      if (existing) {
        await tx.update(freightOpportunities).set({
          companyId,
          origin: opp.originCity,
          originState: opp.originState,
          destination: opp.destCity,
          destinationState: opp.destState,
          equipmentType: equipment,
          pickupWindowStart: pickupDay,
          pickupWindowEnd: pickupDay,
          sourceRef,
          ownerUserId,
          notes: opp.notes,
        }).where(and(
          eq(freightOpportunities.id, existing.id),
          eq(freightOpportunities.orgId, orgId),
        ));
        console.log(`[customer-quotes] AF handoff updated existing opp=${existing.id} quote=${opp.id}`);
        return { id: existing.id, created: false };
      }

      const insert: InsertFreightOpportunity = {
        orgId,
        companyId,
        mode: "exact_load",
        origin: opp.originCity,
        originState: opp.originState,
        destination: opp.destCity,
        destinationState: opp.destState,
        equipmentType: equipment,
        pickupWindowStart: pickupDay,
        pickupWindowEnd: pickupDay,
        loadCount: 1,
        sourceRef,
        urgencyScore: 70,
        status: "ready_to_send",
        createdById: actorUserId,
        ownerUserId,
        notes: opp.notes,
      };
      const [createdRow] = await tx.insert(freightOpportunities).values(insert)
        .returning({ id: freightOpportunities.id });
      console.log(`[customer-quotes] AF handoff created opp=${createdRow?.id} quote=${opp.id} pickup=${pickupDay}`);
      return createdRow ? { id: createdRow.id, created: true } : null;
    });
  } catch (err) {
    console.error(`[customer-quotes] AF handoff failed quote=${opp.id}:`, err);
    return null;
  }
}

// Task #477 — Idempotent: if a lane already exists for this quote, returns it.
// Maps quote → recurring_lane: equipment normalized; companyId resolved by
// case-insensitive name match against companies; ownerUserId from
// quoteRep.userId when present. isManual=true so the eligibility engine does
// not retract it. assignedAt is set to "now" so the lane shows up immediately
// on the rep's procurement hub.
async function createLwqLaneFromWonQuote(orgId: string, opp: QuoteOpportunity): Promise<string | null> {
  try {
    const existing = await getLwqLaneForQuote(orgId, opp.id);
    if (existing) return existing.laneId;

    const [cust] = await db.select().from(quoteCustomers)
      .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, opp.customerId))).limit(1);
    const customerName = cust?.name ?? null;

    let companyId: string | null = null;
    if (customerName) {
      const [matched] = await db.select({ id: companies.id }).from(companies)
        .where(and(eq(companies.organizationId, orgId), sql`LOWER(${companies.name}) = LOWER(${customerName})`))
        .limit(1);
      if (matched) companyId = matched.id;
    }

    let ownerUserId: string | null = null;
    if (opp.repId) {
      const [r] = await db.select({ userId: quoteReps.userId }).from(quoteReps)
        .where(eq(quoteReps.id, opp.repId)).limit(1);
      ownerUserId = r?.userId ?? null;
    }

    const origin = `${opp.originCity}, ${opp.originState}`;
    const destination = `${opp.destCity}, ${opp.destState}`;
    const equipment = normalizeEquipmentType(opp.equipment);

    const [lane] = await db.insert(recurringLanes).values({
      orgId,
      companyId,
      companyName: customerName,
      origin,
      originState: opp.originState,
      destination,
      destinationState: opp.destState,
      equipmentType: equipment,
      ownerUserId,
      isManual: true,
      isEligible: true,
      sourceQuoteId: opp.id,
      assignedAt: new Date().toISOString(),
    }).returning({ id: recurringLanes.id });
    return lane?.id ?? null;
  } catch (err) {
    console.error("[customer-quotes] LWQ lane handoff failed:", err);
    return null;
  }
}

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

export async function createQuote(orgId: string, actor: string, input: CreateQuoteInput, actorUserId?: string | null): Promise<QuoteOpportunity> {
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
  const insertedEvents = await db.insert(quoteEvents).values(events).returning();
  for (const ev of insertedEvents) {
    await logQuoteTouchpointFromEvent({
      orgId, oppId: opp.id, eventId: ev.id, eventType: ev.eventType,
      occurredAt: ev.occurredAt, fallbackUserId: actorUserId ?? null,
    });
  }

  // Task #477 — A quote can be created already in a "won" state (e.g. backfill
  // from CSV). In that case, run the same LWQ handoff path used by updates.
  if (isWon(opp.outcomeStatus)) {
    const laneId = await createLwqLaneFromWonQuote(orgId, opp);
    if (laneId) {
      const [handoffEvent] = await db.insert(quoteEvents).values({
        quoteId: opp.id, eventType: "lwq_handoff", occurredAt: new Date(), actor,
        payload: { laneId },
      }).returning();
      if (handoffEvent) {
        await logQuoteTouchpointFromEvent({
          orgId, oppId: opp.id, eventId: handoffEvent.id, eventType: handoffEvent.eventType,
          occurredAt: handoffEvent.occurredAt, fallbackUserId: actorUserId ?? null,
        });
      }
    }
  }

  // Task #654 — Same as the LWQ block above: a quote can be created already
  // won (manual rep entry of a closed deal, CSV backfill, etc.). Run the AF
  // handoff here too so the create-time-won path matches the
  // update-to-won path. The helper is idempotent and self-gates on the
  // 72h window / org setting.
  if (isWon(opp.outcomeStatus)) {
    const handoff = await createFreightOpportunityFromWonQuote(orgId, opp, actorUserId ?? null);
    if (handoff?.created) {
      const [handoffEvent] = await db.insert(quoteEvents).values({
        quoteId: opp.id, eventType: "af_handoff", occurredAt: new Date(), actor,
        payload: { opportunityId: handoff.id },
      }).returning();
      if (handoffEvent) {
        await logQuoteTouchpointFromEvent({
          orgId, oppId: opp.id, eventId: handoffEvent.id, eventType: handoffEvent.eventType,
          occurredAt: handoffEvent.occurredAt, fallbackUserId: actorUserId ?? null,
        });
      }
    }
  }
  return opp;
}

export async function updateQuote(orgId: string, actor: string, id: string, patch: UpdateQuoteInput, actorUserId?: string | null): Promise<QuoteOpportunity> {
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
  if (eventsToAdd.length > 0) {
    const insertedEvents = await db.insert(quoteEvents).values(eventsToAdd).returning();
    for (const ev of insertedEvents) {
      await logQuoteTouchpointFromEvent({
        orgId, oppId: id, eventId: ev.id, eventType: ev.eventType,
        occurredAt: ev.occurredAt, fallbackUserId: actorUserId ?? null,
      });
    }
  }

  // Customer Quotes #3 — sender-domain learning. When a rep manually
  // moves a quote out of the Unknown bucket into a real customer, record
  // a learned mapping so the next email from that sender lands directly
  // on the resolved customer. Wrapped in try/catch — a learning miss
  // must never fail the underlying reassign. We only fire this when the
  // OLD customer was an Unknown bucket, matching the bulk-reassign rule
  // and avoiding noisy writes from administrative cleanups between two
  // real customers.
  if (changes.customerId && updated.customerId) {
    try {
      const ctx = await loadContext(orgId);
      const unknownIds = unknownCustomerIdsFromMap(ctx.customerMap);
      if (unknownIds.has(existing.customerId)) {
        await learnFromReassign(orgId, updated.sourceReference, updated.customerId);
      }
    } catch (err) {
      console.error("[customer-quotes] sender-mapping learn failed", err);
    }
  }

  // Task #477 — On transition to a "won" status, hand off to LWQ unless the
  // caller explicitly opted out. Idempotent: createLwqLaneFromWonQuote
  // checks for an existing lane keyed on source_quote_id before inserting.
  if (changes.outcomeStatus && isWon(updated.outcomeStatus) && !patch.skipLwqHandoff) {
    const laneId = await createLwqLaneFromWonQuote(orgId, updated);
    if (laneId) {
      const [handoffEvent] = await db.insert(quoteEvents).values({
        quoteId: id, eventType: "lwq_handoff", occurredAt: new Date(), actor,
        payload: { laneId },
      }).returning();
      if (handoffEvent) {
        await logQuoteTouchpointFromEvent({
          orgId, oppId: id, eventId: handoffEvent.id, eventType: handoffEvent.eventType,
          occurredAt: handoffEvent.occurredAt, fallbackUserId: actorUserId ?? null,
        });
      }
    }
  }

  // Task #654 — Same-day cover handoff. When pickup is within 72h, also push
  // the won quote into the Available Freight cockpit so it lands on the
  // spot-dispatch surface alongside any LWQ lane that was created above.
  // Fires on ANY save where the resulting status is won — including
  // re-saves of an already-won quote (e.g. the rep edits buy/sell/notes
  // after marking won). The helper is idempotent (advisory-locked upsert)
  // and short-circuits on org setting / window / company resolution. The
  // af_handoff event + touchpoint are only emitted on the very first
  // creation so re-saves don't spam the audit trail.
  if (isWon(updated.outcomeStatus)) {
    const handoff = await createFreightOpportunityFromWonQuote(orgId, updated, actorUserId ?? null);
    if (handoff?.created) {
      const [handoffEvent] = await db.insert(quoteEvents).values({
        quoteId: id, eventType: "af_handoff", occurredAt: new Date(), actor,
        payload: { opportunityId: handoff.id },
      }).returning();
      if (handoffEvent) {
        await logQuoteTouchpointFromEvent({
          orgId, oppId: id, eventId: handoffEvent.id, eventType: handoffEvent.eventType,
          occurredAt: handoffEvent.occurredAt, fallbackUserId: actorUserId ?? null,
        });
      }
    }
  }
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
  const nonCustomerIds = nonCustomerCustomerIdsFromMap(ctx.customerMap);
  const filtered = applyFilters(all, filters, nonCustomerIds);
  const enriched = enrich(filtered, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);
  enriched.sort((a, b) => b.requestDate.getTime() - a.requestDate.getTime());
  return quotesToCsv(enriched);
}

// ---------- Spot Quote Search (Task #505) ----------

export type SpotSearchInput = {
  pickupCity: string;
  pickupState: string;
  deliveryCity: string;
  deliveryState: string;
  equipment?: string | null;
  pickupDate?: string | null;
  customerId?: string | null;
  // Advanced
  lookbackDays?: number | null;
  exactOnly?: boolean | null;
  includeSimilar?: boolean | null;
  // Task #514 — Tiered Matching. "strict" preserves the legacy
  // exact + same-state-pair behavior. "relaxed" (default) walks the
  // full tier ladder: exact → same_market → same_state → reverse_lane → same_corridor.
  matchMode?: "strict" | "relaxed" | null;
};

// Task #514 — Minimum number of won quotes required for a tier to
// "win" the guidance band walk. Externalized via env so brokers can
// tune confidence vs. coverage without a code change. Defaults to 4
// (legacy hardcoded value). Floor of 1 to keep walks well-defined.
export const SPOT_GUIDANCE_MIN_SAMPLE: number = (() => {
  const raw = parseInt(process.env.SPOT_GUIDANCE_MIN_SAMPLE ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
})();

// Task #514 — Tiered Matching tier identifiers, ordered for display.
export const MATCH_TIERS = [
  "exact",
  "same_market",
  "same_state",
  "reverse_lane",
  "same_corridor",
] as const;
export type MatchTier = typeof MATCH_TIERS[number];

export type EquipmentFamily = "van" | "reefer" | "open" | "other";

/**
 * Map an equipment string to a canonical family. "Van" covers dry van /
 * box truck. "Reefer" covers refrigerated and multi-temp. "Open" covers
 * flatbed / step-deck / RGN style equipment. Anything else falls into
 * "other".
 */
export function equipmentFamily(raw: string | null | undefined): EquipmentFamily {
  const u = (raw ?? "").trim().toLowerCase();
  if (!u) return "other";
  if (
    u === "van" || u === "dry van" || u === "dryvan" ||
    u === "box truck" || u === "box-truck" || u === "boxtruck" ||
    u.includes("dry van") || u.includes("box truck")
  ) return "van";
  if (
    u.includes("reefer") || u.includes("refrig") ||
    u.includes("multi-temp") || u.includes("multi temp") ||
    u === "refr"
  ) return "reefer";
  if (
    u.includes("flat") || u.includes("step") || u.includes("rgn") ||
    u.includes("rgon") || u.includes("double-drop") || u.includes("double drop") ||
    u.includes("conestoga")
  ) return "open";
  return "other";
}

/**
 * Same-market test for a single endpoint: equal city, OR within ~75 mi
 * by haversine, OR — as a fallback when coords are missing — sharing
 * the same KMA (the closest stand-in we have for "shared 3-digit ZIP"
 * given quote_opportunities lacks postal codes). Picks up neighboring
 * origin/destination cities reps think of as "the same market"
 * (Long Beach ↔ Compton, Phoenix ↔ Glendale AZ, etc).
 */
function endpointsSameMarket(
  cityA: string, stateA: string, cityB: string, stateB: string,
  withinMiles = 75,
): boolean {
  if (ciEq(cityA, cityB) && ciEq(stateA, stateB)) return true;
  const a = getCityCoords(`${cityA}, ${stateA}`);
  const b = getCityCoords(`${cityB}, ${stateB}`);
  if (a && b) {
    const d = haversineDistanceMiles(a[0], a[1], b[0], b[1]);
    if (isFinite(d) && d <= withinMiles) return true;
  }
  // Fallback when coordinates are missing for either endpoint: shared
  // KMA stands in for the spec's "shared 3-digit ZIP" concept (we
  // don't store postal codes on quote_opportunities). Only used as a
  // backstop so coord-known pairs aren't reclassified.
  if (!a || !b) {
    const kmaA = cityToKma(cityA, stateA);
    const kmaB = cityToKma(cityB, stateB);
    if (kmaA && kmaB && kmaA.kma === kmaB.kma) return true;
  }
  return false;
}

/**
 * Classify a quote opportunity against the search lane. Each opportunity
 * resolves to exactly one tier (or null if it doesn't qualify under any
 * tier). Precedence order: exact → same_market → same_state → reverse_lane
 * → same_corridor.
 */
export function classifyMatchTier(
  input: { pickupCity: string; pickupState: string; deliveryCity: string; deliveryState: string },
  r: { originCity: string; originState: string; destCity: string; destState: string },
): MatchTier | null {
  const exact =
    ciEq(r.originCity, input.pickupCity) && ciEq(r.originState, input.pickupState) &&
    ciEq(r.destCity, input.deliveryCity) && ciEq(r.destState, input.deliveryState);
  if (exact) return "exact";

  const originSameMarket = endpointsSameMarket(
    r.originCity, r.originState, input.pickupCity, input.pickupState,
  );
  const destSameMarket = endpointsSameMarket(
    r.destCity, r.destState, input.deliveryCity, input.deliveryState,
  );
  if (originSameMarket && destSameMarket) return "same_market";

  if (
    ciEq(r.originState, input.pickupState) && ciEq(r.destState, input.deliveryState)
  ) return "same_state";

  // Reverse: market-equal endpoints, but origin/destination roles flipped.
  const reverseOriginMarket = endpointsSameMarket(
    r.originCity, r.originState, input.deliveryCity, input.deliveryState,
  );
  const reverseDestMarket = endpointsSameMarket(
    r.destCity, r.destState, input.pickupCity, input.pickupState,
  );
  if (reverseOriginMarket && reverseDestMarket) return "reverse_lane";

  // Corridor: a one-sided KMA touch — at least one endpoint shares a
  // KMA (origin OR destination), but the lane doesn't qualify under
  // the tighter tiers above. Catches "in-corridor" partial overlaps
  // such as a quote that starts in the same metro but delivers
  // somewhere else, useful as a soft fallback for pricing context.
  const inOriginKma = cityToKma(input.pickupCity, input.pickupState);
  const inDestKma = cityToKma(input.deliveryCity, input.deliveryState);
  const rOriginKma = cityToKma(r.originCity, r.originState);
  const rDestKma = cityToKma(r.destCity, r.destState);
  const originKmaTouch = !!(inOriginKma && rOriginKma && inOriginKma.kma === rOriginKma.kma);
  const destKmaTouch = !!(inDestKma && rDestKma && inDestKma.kma === rDestKma.kma);
  if (originKmaTouch || destKmaTouch) return "same_corridor";

  return null;
}

/**
 * Walk tier ladder picking the first non-empty tier whose won-quote
 * count meets the minimum sample. Used by the guidance band so that
 * sparse exact history can borrow from the closest non-empty tier.
 */
export function pickGuidanceTier(
  buckets: Record<MatchTier, { won: number[] }>,
  minSample = 4,
): MatchTier | null {
  for (const tier of MATCH_TIERS) {
    if ((buckets[tier]?.won.length ?? 0) >= minSample) return tier;
  }
  return null;
}

const TIER_LABEL: Record<MatchTier, string> = {
  exact: "Exact lane",
  same_market: "Same market (~75 mi)",
  same_state: "Same state pair",
  reverse_lane: "Reverse direction",
  same_corridor: "Same corridor (KMA)",
};

const TIER_RULE_TOOLTIP: Record<MatchTier, string> = {
  exact: "Same origin and destination city + state.",
  same_market: "Both endpoints within ~75 miles by haversine, or sharing the same KMA when coordinates are unavailable.",
  same_state: "Same origin state and destination state, different cities.",
  reverse_lane: "Lane runs in the opposite direction (origin ↔ destination).",
  same_corridor: "At least one endpoint shares a KMA — soft corridor overlap.",
};

export function tierLabel(tier: MatchTier): string { return TIER_LABEL[tier]; }
export function tierTooltip(tier: MatchTier): string { return TIER_RULE_TOOLTIP[tier]; }


export type SpotTierGroup = {
  tier: MatchTier;
  label: string;
  rule: string;
  count: number;
  // Per-tier KPIs (Task #514) — let reps gauge each tier independently.
  winRate: number;            // 0..1, won / decided
  avgWonQuoted: number;       // average quoted amount on won quotes
  lastWonDays: number | null; // freshness of the most recent win
  /** Enriched quote rows for this tier (capped at 25 by service). */
  items: EnrichedQuote[];
  /** @deprecated Backwards-compat alias for `items`. Will be removed once consumers migrate. */
  quotes: EnrichedQuote[];
};

export type SpotSearchKpis = {
  exactCount: number;
  similarCount: number;
  // Task #514 — per-tier counts in display order.
  tierCounts: Record<MatchTier, number>;
  customersOnLane: number;
  winRate: number;
  avgQuoted: number;
  avgWonQuoted: number;
  avgCarrierPaid: number;
  avgMargin: number;
  avgMarginPct: number;
  lastQuotedDays: number | null;
  lastWonDays: number | null;
  pendingCount: number;
  confidence: "high" | "medium" | "low" | "insufficient";
  freshnessLabel: "fresh" | "recent" | "stale" | "none";
};

export type SpotCustomerStat = {
  customerId: string;
  customerName: string;
  quotes: number;
  wins: number;
  losses: number;
  winRate: number;
  avgQuoted: number;
  avgMargin: number;
  lastQuotedDays: number | null;
  topCarriers: { name: string; loads: number }[];
};

export type SpotOutcomeReason = { reason: string; status: string; count: number; pct: number };

export type SpotCarrierHistory = {
  carrierId: string | null;
  name: string;
  loads: number;
  avgPaid: number;
  lowPaid: number;
  highPaid: number;
  lastUsedDays: number | null;
};

export type SpotInternalVariance = {
  rep: string;
  count: number;
  avgQuoted: number;
  winRate: number;
  avgMargin: number;
};

export type SpotAttractiveness = {
  score: number;
  label: AttractivenessItem["label"];
  rationale: string;
  totalQuotes: number;
  decided: number;
  winRate: number;
  avgMargin: number;
};

export type SpotGuidance = {
  suggestedLow: number | null;
  suggestedHigh: number | null;
  benchmark: number | null;
  /** Task #515 — Falls back to the tiered-matching tier label (e.g. "exact",
   * "same_market") when neither TRAC nor a stored band is available. */
  benchmarkSource: PricingIntelligence["benchmarkSource"] | "trac" | MatchTier;
  confidence: PricingIntelligence["confidence"];
  message: string;
  /** Task #514 — which tier the guidance band was actually derived from. */
  tierUsed: MatchTier | null;
  /**
   * Task #515 — Internal won-quote band kept as a calibration reference
   * when TRAC becomes the primary band. Lets reps compare the market
   * benchmark against their own historical wins.
   */
  calibration?: {
    suggestedLow: number | null;
    suggestedHigh: number | null;
    source: PricingIntelligence["benchmarkSource"];
    tierUsed: MatchTier | null;
    sample: number;
    note: string;
  } | null;
};

export type SpotAlert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
};

export type SpotSearchResult = {
  query: SpotSearchInput;
  resolvedCustomer: { id: string; name: string } | null;
  kpis: SpotSearchKpis;
  guidance: SpotGuidance;
  exactMatches: EnrichedQuote[];
  similarMatches: EnrichedQuote[];
  // Task #514 — Tiered Matching: per-tier groups in display order. Empty
  // tiers are omitted. exactMatches/similarMatches above remain populated
  // for backwards compatibility with older clients.
  tieredMatches: SpotTierGroup[];
  customerPanel: SpotCustomerStat[];
  outcomeBreakdown: SpotOutcomeReason[];
  carrierHistory: SpotCarrierHistory[];
  internalVariance: SpotInternalVariance[];
  attractiveness: SpotAttractiveness;
  alerts: SpotAlert[];
  /** Task #515 — External data layering. Each lookup degrades independently. */
  market: LaneMarket | null;
  marketStatus: { available: boolean; reason: string | null };
  laneTraffic: (LaneTraffic & { lookbackDays: number; avgRevenuePerLoad: number; avgCostPerLoad: number; avgMarginPerLoad: number }) | null;
  carrierOutreach: CarrierOutreachItem[];
  corridorPattern: CorridorPattern | null;
};

function avg(nums: number[]): number {
  const v = nums.filter(n => isFinite(n));
  if (!v.length) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function daysSince(d: Date | null | undefined): number | null {
  if (!d) return null;
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

export async function searchSpotQuote(orgId: string, input: SpotSearchInput): Promise<SpotSearchResult> {
  const ctx = await loadContext(orgId);
  const baseOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId))
    .orderBy(desc(quoteOpportunities.requestDate));

  // Lookback filter
  const lookbackDays = input.lookbackDays && input.lookbackDays > 0 ? input.lookbackDays : null;
  const cutoff = lookbackDays ? Date.now() - lookbackDays * 24 * 3600 * 1000 : null;
  const allOpps = cutoff
    ? baseOpps.filter(r => r.requestDate.getTime() >= cutoff)
    : baseOpps;

  const equipment = (input.equipment ?? "").trim();
  const eqLower = equipment.toLowerCase();
  // Family-based equipment match — keeps "van" loose (van + dry van + box truck)
  // and groups flatbed/step-deck under "open". "Other" matches the catch-all
  // family. "Any" / blank matches everything.
  const inputFamily = equipment && eqLower !== "any" ? equipmentFamily(equipment) : null;
  // Task #514 — Equipment matching policy:
  // - Default (and strict mode) preserves legacy behavior: family-level
  //   matching (van groups dry van + box truck, open groups flatbed +
  //   step-deck, etc).
  // - The "Exact matches only" lane toggle (`exactOnly`) is the single
  //   explicit knob a rep flips to force exact equipment-string equality.
  // matchMode is intentionally NOT coupled to equipment matching so
  // that strict mode is behaviorally identical to legacy on equipment.
  const matchModeEarly: "strict" | "relaxed" = input.matchMode === "strict" ? "strict" : "relaxed";
  const forceExactEquipment = !!input.exactOnly;
  const eqMatch = (r: QuoteOpportunity): boolean => {
    if (!inputFamily) return true;
    if (forceExactEquipment) {
      return (r.equipment ?? "").trim().toLowerCase() === eqLower;
    }
    if (inputFamily === "other") return equipmentFamily(r.equipment) === "other";
    return equipmentFamily(r.equipment) === inputFamily;
  };

  // Task #514 — Tiered matching. Classify every (equipment-matched)
  // opportunity into exactly one tier. matchMode "strict" only retains
  // exact + same_state to mirror the legacy two-tier UI (and forces
  // exact equipment-string equality, see forceExactEquipment above).
  const matchMode = matchModeEarly;
  const exactOnly = !!input.exactOnly;
  const includeSimilar = input.includeSimilar !== false && !exactOnly;

  const tierBuckets: Record<MatchTier, QuoteOpportunity[]> = {
    exact: [], same_market: [], same_state: [], reverse_lane: [], same_corridor: [],
  };
  for (const r of allOpps) {
    if (!eqMatch(r)) continue;
    const tier = classifyMatchTier(input, r);
    if (!tier) continue;
    if (matchMode === "strict" && tier !== "exact" && tier !== "same_state") continue;
    if (exactOnly && tier !== "exact") continue;
    if (!includeSimilar && tier !== "exact") continue;
    tierBuckets[tier].push(r);
  }

  const exact = tierBuckets.exact;
  // Similar (legacy): union of every non-exact tier in display order.
  const similar: QuoteOpportunity[] = [
    ...tierBuckets.same_market,
    ...tierBuckets.same_state,
    ...tierBuckets.reverse_lane,
    ...tierBuckets.same_corridor,
  ];

  const customerId = input.customerId ?? null;
  const scoped = (rs: QuoteOpportunity[]): QuoteOpportunity[] =>
    customerId ? rs.filter(r => r.customerId === customerId) : rs;
  const exactScoped = scoped(exact);
  const similarScoped = scoped(similar);
  const tierBucketsScoped: Record<MatchTier, QuoteOpportunity[]> = {
    exact: exactScoped,
    same_market: scoped(tierBuckets.same_market),
    same_state: scoped(tierBuckets.same_state),
    reverse_lane: scoped(tierBuckets.reverse_lane),
    same_corridor: scoped(tierBuckets.same_corridor),
  };

  const won = exactScoped.filter(r => isWon(r.outcomeStatus));
  const lost = exactScoped.filter(r => isLost(r.outcomeStatus));
  const decided = won.length + lost.length;
  const wonWithCarrier = won.filter(r => num(r.carrierPaid) > 0);

  const lastQuotedDays = exactScoped.length > 0 ? daysSince(exactScoped[0].requestDate) : null;

  const lastWonDays = won.length > 0
    ? daysSince(won.reduce((a, b) => (a.requestDate > b.requestDate ? a : b)).requestDate)
    : null;

  let confidence: SpotSearchKpis["confidence"];
  if (exactScoped.length >= 12 && (lastQuotedDays ?? 999) <= 60) confidence = "high";
  else if (exactScoped.length >= 5) confidence = "medium";
  else if (exactScoped.length >= 1) confidence = "low";
  else confidence = "insufficient";

  let freshnessLabel: SpotSearchKpis["freshnessLabel"];
  if (lastQuotedDays === null) freshnessLabel = "none";
  else if (lastQuotedDays <= 14) freshnessLabel = "fresh";
  else if (lastQuotedDays <= 60) freshnessLabel = "recent";
  else freshnessLabel = "stale";

  const tierCounts: Record<MatchTier, number> = {
    exact: tierBucketsScoped.exact.length,
    same_market: tierBucketsScoped.same_market.length,
    same_state: tierBucketsScoped.same_state.length,
    reverse_lane: tierBucketsScoped.reverse_lane.length,
    same_corridor: tierBucketsScoped.same_corridor.length,
  };

  const kpis: SpotSearchKpis = {
    exactCount: exactScoped.length,
    similarCount: similarScoped.length,
    tierCounts,
    customersOnLane: new Set(exact.map(r => r.customerId)).size,
    winRate: decided > 0 ? (won.length / decided) * 100 : 0,
    avgQuoted: avg(exactScoped.map(r => num(r.quotedAmount)).filter(v => v > 0)),
    avgWonQuoted: avg(won.map(r => num(r.quotedAmount)).filter(v => v > 0)),
    avgCarrierPaid: avg(wonWithCarrier.map(r => num(r.carrierPaid))),
    avgMargin: avg(wonWithCarrier.map(r => num(r.quotedAmount) - num(r.carrierPaid))),
    avgMarginPct: avg(wonWithCarrier.map(r => {
      const q = num(r.quotedAmount); return q > 0 ? ((q - num(r.carrierPaid)) / q) * 100 : 0;
    })),
    lastQuotedDays,
    lastWonDays,
    pendingCount: exactScoped.filter(r => r.outcomeStatus === "pending").length,
    confidence,
    freshnessLabel,
  };

  // Guidance: if customer scoped, reuse pricing intelligence; else lane-wide.
  let guidance: SpotGuidance;
  if (customerId) {
    const intel = await getPricingIntelligence(orgId, {
      customerId,
      originCity: input.pickupCity, originState: input.pickupState,
      destCity: input.deliveryCity, destState: input.deliveryState,
      equipment: equipment || undefined,
    });
    guidance = {
      suggestedLow: intel.suggestion?.low ?? null,
      suggestedHigh: intel.suggestion?.high ?? null,
      benchmark: intel.sonarBenchmark,
      benchmarkSource: intel.benchmarkSource,
      confidence: intel.confidence,
      message: intel.message,
      tierUsed: null, // customer-scoped path uses pricing intel, not tier ladder
    };
  } else {
    // Task #514 — Tier-aware guidance: walk the tier ladder and use
    // the first tier with ≥4 won quotes. Confidence steps down as we
    // move away from the exact lane.
    const wonByTier: Record<MatchTier, number[]> = {
      exact: [], same_market: [], same_state: [], reverse_lane: [], same_corridor: [],
    };
    for (const tier of MATCH_TIERS) {
      wonByTier[tier] = tierBucketsScoped[tier]
        .filter(r => isWon(r.outcomeStatus))
        .map(r => num(r.quotedAmount))
        .filter(v => v > 0)
        .sort((a, b) => a - b);
    }
    const guidanceTier = pickGuidanceTier(
      Object.fromEntries(MATCH_TIERS.map(t => [t, { won: wonByTier[t] }])) as Record<MatchTier, { won: number[] }>,
      SPOT_GUIDANCE_MIN_SAMPLE,
    );
    if (guidanceTier) {
      const series = wonByTier[guidanceTier];
      const p25 = series[Math.floor(series.length * 0.25)];
      const p75 = series[Math.floor(series.length * 0.75)];
      const tierConfidence: PricingIntelligence["confidence"] =
        guidanceTier === "exact"
          ? (series.length >= 12 ? "high" : "medium")
          : guidanceTier === "same_market"
          ? (series.length >= 12 ? "medium" : "low")
          : "low";
      // Task #515 — fall back to the tiered-matching tier label as the
      // benchmark source so the UI can clearly show which tier produced
      // the band when neither TRAC nor stored guidance is available.
      const benchmarkSource: SpotGuidance["benchmarkSource"] = guidanceTier;
      guidance = {
        suggestedLow: Math.round(p25),
        suggestedHigh: Math.round(p75),
        benchmark: null,
        benchmarkSource,
        confidence: tierConfidence,
        message: guidanceTier === "exact"
          ? `Based on ${series.length} won quotes on this exact lane (P25–P75 band).`
          : `Exact-lane history sparse — band derived from ${series.length} won quote(s) at the ${TIER_LABEL[guidanceTier].toLowerCase()} tier (P25–P75).`,
        tierUsed: guidanceTier,
      };
    } else {
      const totalWon = MATCH_TIERS.reduce((s, t) => s + wonByTier[t].length, 0);
      guidance = {
        tierUsed: null,
        suggestedLow: null,
        suggestedHigh: null,
        benchmark: null,
        benchmarkSource: "none",
        confidence: "insufficient_history",
        message: totalWon === 0
          ? "No prior won quotes anywhere in the tier ladder — try selecting a customer for tailored guidance."
          : `Only ${totalWon} won quote(s) across all tiers — too few for a reliable range.`,
      };
    }
  }

  // Customer panel: per-customer breakdown on this lane (top 10 by quote count)
  const byCust = new Map<string, QuoteOpportunity[]>();
  for (const r of exact) {
    const arr = byCust.get(r.customerId) ?? [];
    arr.push(r); byCust.set(r.customerId, arr);
  }
  const customerPanel: SpotCustomerStat[] = Array.from(byCust.entries()).map(([cid, list]) => {
    const c = ctx.customerMap.get(cid);
    const w = list.filter(r => isWon(r.outcomeStatus));
    const l = list.filter(r => isLost(r.outcomeStatus));
    const dec = w.length + l.length;
    const wwc = w.filter(r => num(r.carrierPaid) > 0);
    const carriers = new Map<string, number>();
    for (const r of list) {
      if (!r.carrierId) continue;
      const name = ctx.carrierMap.get(r.carrierId)?.name ?? "—";
      carriers.set(name, (carriers.get(name) ?? 0) + 1);
    }
    return {
      customerId: cid,
      customerName: c?.name ?? "—",
      quotes: list.length,
      wins: w.length,
      losses: l.length,
      winRate: dec > 0 ? (w.length / dec) * 100 : 0,
      avgQuoted: avg(list.map(r => num(r.quotedAmount)).filter(v => v > 0)),
      avgMargin: avg(wwc.map(r => num(r.quotedAmount) - num(r.carrierPaid))),
      lastQuotedDays: list.length > 0 ? daysSince(list[0].requestDate) : null,
      topCarriers: Array.from(carriers.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, loads]) => ({ name, loads })),
    };
  }).sort((a, b) => b.quotes - a.quotes).slice(0, 10);

  // Outcome breakdown for exact+scoped
  const totalExact = exactScoped.length || 1;
  const reasonCounts = new Map<string, { reason: string; status: string; count: number }>();
  for (const r of exactScoped) {
    const reason = r.outcomeReasonId
      ? ctx.reasonMap.get(r.outcomeReasonId)?.label ?? r.outcomeStatus
      : (r.outcomeStatus === "pending" ? "Pending" : r.outcomeStatus);
    const key = `${r.outcomeStatus}|${reason}`;
    const cur = reasonCounts.get(key) ?? { reason, status: r.outcomeStatus, count: 0 };
    cur.count++;
    reasonCounts.set(key, cur);
  }
  const outcomeBreakdown: SpotOutcomeReason[] = Array.from(reasonCounts.values())
    .map(r => ({ ...r, pct: (r.count / totalExact) * 100 }))
    .sort((a, b) => b.count - a.count);

  // Carrier history for the lane (won quotes only)
  const carrierMap = new Map<string, { paids: number[]; last: Date | null; cid: string | null }>();
  for (const r of exact.filter(x => isWon(x.outcomeStatus) && num(x.carrierPaid) > 0)) {
    const name = r.carrierId ? ctx.carrierMap.get(r.carrierId)?.name ?? "—" : "Direct/Unknown";
    const cur = carrierMap.get(name) ?? { paids: [], last: null, cid: r.carrierId ?? null };
    cur.paids.push(num(r.carrierPaid));
    if (!cur.last || r.requestDate > cur.last) cur.last = r.requestDate;
    carrierMap.set(name, cur);
  }
  const carrierHistory: SpotCarrierHistory[] = Array.from(carrierMap.entries())
    .map(([name, v]) => ({
      carrierId: v.cid,
      name,
      loads: v.paids.length,
      avgPaid: avg(v.paids),
      lowPaid: Math.min(...v.paids),
      highPaid: Math.max(...v.paids),
      lastUsedDays: daysSince(v.last),
    }))
    .sort((a, b) => b.loads - a.loads)
    .slice(0, 8);

  // Internal variance: per-rep avg quoted on this lane
  const repMap = new Map<string, QuoteOpportunity[]>();
  for (const r of exact) {
    const name = r.repId ? ctx.repMap.get(r.repId)?.name ?? "—" : "Unassigned";
    const arr = repMap.get(name) ?? []; arr.push(r); repMap.set(name, arr);
  }
  const internalVariance: SpotInternalVariance[] = Array.from(repMap.entries())
    .map(([rep, list]) => {
      const w = list.filter(r => isWon(r.outcomeStatus));
      const l = list.filter(r => isLost(r.outcomeStatus));
      const dec = w.length + l.length;
      const wwc = w.filter(r => num(r.carrierPaid) > 0);
      return {
        rep,
        count: list.length,
        avgQuoted: avg(list.map(r => num(r.quotedAmount)).filter(v => v > 0)),
        winRate: dec > 0 ? (w.length / dec) * 100 : 0,
        avgMargin: avg(wwc.map(r => num(r.quotedAmount) - num(r.carrierPaid))),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // Freight attractiveness
  const decAll = exact.filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus));
  const wAll = exact.filter(r => isWon(r.outcomeStatus));
  const wr = decAll.length > 0 ? (wAll.length / decAll.length) * 100 : 0;
  const wAllCarrier = wAll.filter(r => num(r.carrierPaid) > 0);
  const am = avg(wAllCarrier.map(r => num(r.quotedAmount) - num(r.carrierPaid)));
  let label: AttractivenessItem["label"];
  let rationale: string;
  if (wr >= 50 && am >= 250) { label = "Pursue Aggressively"; rationale = `${wr.toFixed(0)}% win rate · $${Math.round(am)} avg margin`; }
  else if (wr >= 35 && am >= 150) { label = "Good Freight"; rationale = `${wr.toFixed(0)}% win rate · $${Math.round(am)} avg margin`; }
  else if (wr >= 20) { label = "Selective"; rationale = `${wr.toFixed(0)}% win rate — quote selectively`; }
  else { label = "Low Quality"; rationale = decAll.length === 0 ? "No decided history yet" : `${wr.toFixed(0)}% win rate — challenging lane`; }
  const score = Math.min(100, Math.round(wr * 0.6 + Math.min(am / 5, 40)));
  const attractiveness: SpotAttractiveness = {
    score, label, rationale,
    totalQuotes: exact.length,
    decided: decAll.length,
    winRate: wr,
    avgMargin: am,
  };

  // Alerts: lost-streak on lane, expiring on lane, low margin, high variance, stale data, sparse history
  const alerts: SpotAlert[] = [];
  if (kpis.freshnessLabel === "stale" && exactScoped.length > 0) {
    alerts.push({
      id: "lane_stale_data",
      severity: "medium",
      title: "Lane data is stale",
      detail: `Last quote was ${lastQuotedDays} days ago — confirm rates before using as guidance.`,
    });
  }
  if (exactScoped.length === 0 && similarScoped.length > 0) {
    alerts.push({
      id: "lane_only_similar",
      severity: "medium",
      title: "No exact match history",
      detail: `Guidance relies on ${similarScoped.length} similar-lane quote(s) — use with caution.`,
    });
  } else if (exactScoped.length > 0 && exactScoped.length < 3) {
    alerts.push({
      id: "lane_sparse_history",
      severity: "low",
      title: "Limited exact-match history",
      detail: `Only ${exactScoped.length} prior quote(s) on this exact lane.`,
    });
  }
  // Lost streak (last 5 decided in chronological order)
  const recentDecided = exactScoped
    .filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus))
    .slice(0, 5);
  if (recentDecided.length >= 3 && recentDecided.every(r => isLost(r.outcomeStatus))) {
    alerts.push({
      id: "lane_lost_streak",
      severity: "high",
      title: `${recentDecided.length} consecutive losses on this lane`,
      detail: "Recent quotes lost — review pricing or service positioning.",
    });
  }
  const expiringSoon = exactScoped.filter(r => {
    if (r.outcomeStatus !== "pending" || !r.validThrough) return false;
    const ms = r.validThrough.getTime() - Date.now();
    return ms >= 0 && ms <= 3 * 24 * 3600 * 1000;
  });
  if (expiringSoon.length > 0) {
    alerts.push({
      id: "lane_expiring",
      severity: "medium",
      title: `${expiringSoon.length} quote${expiringSoon.length === 1 ? "" : "s"} expiring soon`,
      detail: "Pending quotes on this lane expire within 3 days.",
    });
  }
  if (internalVariance.length >= 2) {
    const amounts = internalVariance.filter(v => v.avgQuoted > 0).map(v => v.avgQuoted);
    if (amounts.length >= 2) {
      const lo = Math.min(...amounts), hi = Math.max(...amounts);
      const spreadPct = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
      if (spreadPct >= 15) {
        alerts.push({
          id: "lane_internal_variance",
          severity: "medium",
          title: `Reps quoting this lane vary by ${spreadPct.toFixed(0)}%`,
          detail: `Range $${Math.round(lo)}–$${Math.round(hi)} across reps — alignment needed.`,
        });
      }
    }
  }

  const exactMatches = enrich(exactScoped.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);
  const similarMatches = enrich(similarScoped.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);

  // Task #515 — External data layering. Run TRAC + load_fact + Carrier Hub
  // outreach + corridor pattern in parallel; each degrades independently.
  const [marketRes, laneTrafficRes, carrierOutreachRes, corridorRes] = await Promise.all([
    getLaneMarket(input.pickupCity, input.pickupState, input.deliveryCity, input.deliveryState, equipment || null)
      .catch(err => ({ ok: false as const, reason: (err as Error).message ?? "TRAC error" })),
    getLaneTraffic(
      orgId,
      input.pickupCity,
      input.pickupState,
      input.deliveryCity,
      input.deliveryState,
      equipment || null,
      input.lookbackDays && input.lookbackDays > 0 ? input.lookbackDays : 90,
    ).catch(() => null),
    getLaneCarriers(orgId, input.pickupState, input.deliveryState, equipment || null)
      .catch(() => [] as CarrierOutreachItem[]),
    getCorridorPattern(orgId, input.pickupState, input.deliveryState)
      .catch(() => null),
  ]);
  const market: LaneMarket | null = marketRes.ok ? marketRes.market : null;
  const marketStatus = marketRes.ok
    ? { available: true, reason: null }
    : { available: false, reason: marketRes.reason };
  const laneTraffic: SpotSearchResult["laneTraffic"] = laneTrafficRes;
  const carrierOutreach: CarrierOutreachItem[] = carrierOutreachRes ?? [];
  const corridorPattern: CorridorPattern | null = corridorRes;

  // Promote TRAC band as the primary pricing benchmark when present;
  // demote the internal won-quote band to "calibration" so reps still
  // see how their wins compare. Customer-scoped guidance is left
  // untouched (it already merges TRAC via getPricingIntelligence).
  if (!customerId && market && market.band) {
    const internalLow = guidance.suggestedLow;
    const internalHigh = guidance.suggestedHigh;
    const internalSource = guidance.benchmarkSource;
    const internalTier = guidance.tierUsed;
    const internalSample = (() => {
      if (!guidance.tierUsed) return 0;
      // Lazy: re-derive from the won-by-tier counts via tierBucketsScoped.
      return tierBucketsScoped[guidance.tierUsed].filter(r => isWon(r.outcomeStatus)).length;
    })();
    const tracMid = market.band.mid;
    const calNote = internalLow != null && internalHigh != null
      ? `Internal P25–P75 across ${internalSample} won quote(s)${internalTier ? ` at the ${TIER_LABEL[internalTier].toLowerCase()} tier` : ""}.`
      : "No internal won-quote history to calibrate against.";
    const calibration: NonNullable<SpotGuidance["calibration"]> = {
      suggestedLow: internalLow,
      suggestedHigh: internalHigh,
      source: internalSource === "trac"
        ? "none"
        : (internalSource === "stored_recent" || internalSource === "stored_avg" || internalSource === "similar_lanes" || internalSource === "none")
        ? internalSource
        // tier-label fallback collapses to "similar_lanes" semantics for the
        // calibration channel which is shaped by PricingIntelligence.
        : "similar_lanes",
      tierUsed: internalTier,
      sample: internalSample,
      note: calNote,
    };
    const conf: SpotGuidance["confidence"] =
      market.confidence != null && market.confidence >= 70 ? "high"
      : market.confidence != null && market.confidence >= 40 ? "medium"
      : "low";
    guidance = {
      suggestedLow: market.band.low,
      suggestedHigh: market.band.high,
      benchmark: tracMid,
      benchmarkSource: "trac",
      confidence: conf,
      message: `TRAC market band ${market.originKma}→${market.destKma} (${market.equipment})${market.loadCount ? ` · ${market.loadCount} loads` : ""}${market.confidence != null ? ` · ${market.confidence}% confidence` : ""}.`,
      tierUsed: internalTier,
      calibration,
    };
  } else if (market && market.band && customerId) {
    // Customer-scoped path: still expose TRAC as a benchmark line if
    // pricingIntelligence didn't already populate one.
    if (guidance.benchmark == null) {
      guidance = { ...guidance, benchmark: market.band.mid };
    }
  }

  // Task #514 — per-tier KPIs so each tier card can stand alone.
  const nowMs = Date.now();
  const tieredMatches: SpotTierGroup[] = MATCH_TIERS
    .map(tier => {
      const list = tierBucketsScoped[tier];
      if (list.length === 0) return null;
      const decided = list.filter(r => isWon(r.outcomeStatus) || isLost(r.outcomeStatus));
      const wonRows = list.filter(r => isWon(r.outcomeStatus));
      const wonAmts = wonRows.map(r => num(r.quotedAmount)).filter(v => v > 0);
      const winRate = decided.length > 0 ? wonRows.length / decided.length : 0;
      const avgWonQuoted = wonAmts.length > 0
        ? wonAmts.reduce((s, v) => s + v, 0) / wonAmts.length
        : 0;
      const lastWonMs = wonRows
        .map(r => new Date(String(r.requestDate)).getTime())
        .filter(t => Number.isFinite(t))
        .sort((a, b) => b - a)[0];
      const lastWonDays = lastWonMs
        ? Math.max(0, Math.round((nowMs - lastWonMs) / 86_400_000))
        : null;
      const items = enrich(list.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap);
      return {
        tier,
        label: TIER_LABEL[tier],
        rule: TIER_RULE_TOOLTIP[tier],
        count: list.length,
        winRate,
        avgWonQuoted,
        lastWonDays,
        items,
        quotes: items, // backwards-compat alias
      } satisfies SpotTierGroup;
    })
    .filter((g): g is SpotTierGroup => g !== null);

  return {
    query: input,
    resolvedCustomer: customerId
      ? { id: customerId, name: ctx.customerMap.get(customerId)?.name ?? "—" }
      : null,
    kpis,
    guidance,
    exactMatches,
    similarMatches,
    tieredMatches,
    customerPanel,
    outcomeBreakdown,
    carrierHistory,
    internalVariance,
    attractiveness,
    alerts,
    market,
    marketStatus,
    laneTraffic,
    carrierOutreach,
    corridorPattern,
  };
}

export type LaneAutocompleteItem = {
  city: string;
  state: string;
  count: number;
  // Task #510 — optional source tag so the client can render
  // historical lane matches separately from generic US-city matches.
  source?: "history" | "city";
};

interface UsCityRow { city: string; state: string; aliases: string[] }
let US_CITIES_CACHE: UsCityRow[] | null = null;
function getUsCitiesData(): UsCityRow[] {
  if (US_CITIES_CACHE) return US_CITIES_CACHE;
  try {
    // Reuse the same bundled dataset the client uses for autocomplete.
    const filePath = join(process.cwd(), "client", "src", "data", "usCities.json");
    US_CITIES_CACHE = JSON.parse(readFileSync(filePath, "utf-8")) as UsCityRow[];
  } catch (err) {
    console.warn("[customer-quotes] failed to load usCities.json:", err);
    US_CITIES_CACHE = [];
  }
  return US_CITIES_CACHE;
}

const HISTORY_LIMIT = 8;
const CITY_LIMIT = 12;

export async function laneAutocomplete(
  orgId: string, q: string, kind: "origin" | "dest",
): Promise<LaneAutocompleteItem[]> {
  const term = q.trim().toLowerCase();
  if (term.length < 1) return [];
  const all = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));
  const counts = new Map<string, LaneAutocompleteItem>();
  for (const r of all) {
    const city = kind === "origin" ? r.originCity : r.destCity;
    const state = kind === "origin" ? r.originState : r.destState;
    const blob = `${city}, ${state}`.toLowerCase();
    if (!blob.includes(term)) continue;
    const key = `${city}|${state}`;
    const cur = counts.get(key) ?? { city, state, count: 0, source: "history" as const };
    cur.count++;
    counts.set(key, cur);
  }
  const history: LaneAutocompleteItem[] = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, HISTORY_LIMIT)
    .map(h => ({ ...h, source: "history" }));

  // Augment with prefix matches from the bundled US cities dataset so
  // reps can find any city even if it has never been quoted before.
  const seen = new Set(history.map(h => `${h.city.toLowerCase()}|${h.state}`));
  const cityRows = getUsCitiesData();
  const cityMatches: LaneAutocompleteItem[] = [];
  for (const entry of cityRows) {
    const names = [entry.city, ...entry.aliases];
    let matched = false;
    for (const n of names) {
      const lower = n.toLowerCase();
      if (lower.startsWith(term) || `${lower}, ${entry.state.toLowerCase()}`.startsWith(term)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const key = `${entry.city.toLowerCase()}|${entry.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cityMatches.push({ city: entry.city, state: entry.state, count: 0, source: "city" });
    if (cityMatches.length >= CITY_LIMIT * 2) break;
  }
  // Prefer shorter city names (closer to the prefix) and stable alphabetical order.
  cityMatches.sort((a, b) =>
    a.city.length - b.city.length || a.city.localeCompare(b.city) || a.state.localeCompare(b.state),
  );

  return [...history, ...cityMatches.slice(0, CITY_LIMIT)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Task #673 — Freight Capture Funnel
//
// A sliceable funnel view of quote opportunities by stage:
//   Request Received → Quoted → Follow-up Sent → Booked / Won
//   plus parallel exits: Lost, Stale / No Response.
//
// Reuses `loadContext` + `applyFilters` so the same Customer/Rep/Equipment/
// Outcome/Date filters that drive the snapshot work the same way here.
// Stale = pending and >14 days old, OR explicitly no_response/expired.
// Follow-up signal = a quote_events row with eventType in (revised, followup)
// for the quote.
// ─────────────────────────────────────────────────────────────────────────────

const STALE_AGE_DAYS = 14;
const FUNNEL_FOLLOWUP_EVENT_TYPES = ["revised", "followup"] as const;

export type FunnelStageKey =
  | "received"
  | "quoted"
  | "followup"
  | "won"
  | "lost"
  | "stale";

export type FunnelStage = {
  key: FunnelStageKey;
  label: string;
  count: number;
  // Percent of the immediately preceding stage. Null on the first stage.
  conversionPct: number | null;
  // Percent of "received" so the UI can show absolute funnel share.
  shareOfReceivedPct: number;
};

export type FunnelLossReason = { reasonId: string | null; label: string; count: number };

export type FunnelPerformerRow = {
  id: string;
  label: string;
  total: number;
  won: number;
  lost: number;
  winRate: number;
  avgQuoted: number;
};

export type FunnelPerformerSplit = {
  best: FunnelPerformerRow[];
  worst: FunnelPerformerRow[];
};

export type FunnelPerformers = {
  lanes: FunnelPerformerSplit;
  customers: FunnelPerformerSplit;
  reps: FunnelPerformerSplit;
};

export type FunnelSummary = {
  totalReceived: number;
  totalQuoted: number;
  totalWon: number;
  totalLost: number;
  totalStale: number;
  // Quote-to-Book = won / received.
  quoteToBookPct: number;
  // Win rate among decided quotes (won + lost).
  winRatePct: number;
  // Average response time across the filtered set.
  avgResponseTimeHours: number;
  // % of quoted that received a follow-up touch.
  followUpCompliancePct: number;
};

export type FunnelResult = {
  stages: FunnelStage[];
  summary: FunnelSummary;
  lossReasons: FunnelLossReason[];
  performers: FunnelPerformers;
  // Echoes the rep id the server scoped the data to (when an account_manager
  // is the viewer). Null for admins/directors who see the full org.
  scopedToRepId: string | null;
};

/**
 * Resolve the QuoteRep row that a non-admin viewer should be scoped to.
 * Returns null if the role sees the org-wide funnel; returns the rep id
 * when the user is mapped to a QuoteRep; returns the sentinel "__none__"
 * when the user is in a scoped role but has no rep mapping (so the caller
 * can short-circuit to an empty result).
 *
 * RBAC policy (matches managerRoles used elsewhere in the codebase):
 *   - elevated (org-wide):    admin, director, sales_director,
 *                             national_account_manager, sales
 *   - rep-scoped (self-only): account_manager, logistics_manager,
 *                             logistics_coordinator
 * Any other role falls into rep-scoped by default to fail closed.
 */
export async function resolveFunnelRepScope(
  orgId: string,
  user: { id: string; role: string },
): Promise<string | null | "__none__"> {
  const elevated = new Set([
    "admin",
    "director",
    "sales_director",
    "national_account_manager",
    "sales",
  ]);
  if (elevated.has(user.role)) return null;
  const [rep] = await db
    .select({ id: quoteReps.id })
    .from(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.userId, user.id)))
    .limit(1);
  return rep?.id ?? "__none__";
}

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return (num / den) * 100;
}

function emptyFunnelResult(scopedToRepId: string | null): FunnelResult {
  const stages: FunnelStage[] = [
    { key: "received", label: "Request Received", count: 0, conversionPct: null, shareOfReceivedPct: 0 },
    { key: "quoted", label: "Quoted", count: 0, conversionPct: 0, shareOfReceivedPct: 0 },
    { key: "followup", label: "Follow-up Sent", count: 0, conversionPct: 0, shareOfReceivedPct: 0 },
    { key: "won", label: "Booked / Won", count: 0, conversionPct: 0, shareOfReceivedPct: 0 },
    { key: "lost", label: "Lost", count: 0, conversionPct: 0, shareOfReceivedPct: 0 },
    { key: "stale", label: "Stale / No Response", count: 0, conversionPct: 0, shareOfReceivedPct: 0 },
  ];
  return {
    stages,
    summary: {
      totalReceived: 0, totalQuoted: 0, totalWon: 0, totalLost: 0, totalStale: 0,
      quoteToBookPct: 0, winRatePct: 0, avgResponseTimeHours: 0, followUpCompliancePct: 0,
    },
    lossReasons: [],
    performers: {
      lanes: { best: [], worst: [] },
      customers: { best: [], worst: [] },
      reps: { best: [], worst: [] },
    },
    scopedToRepId,
  };
}

export async function getFunnel(
  orgId: string,
  filters: QuoteFilters,
  scopedRepId: string | null | "__none__" = null,
): Promise<FunnelResult> {
  if (scopedRepId === "__none__") {
    return emptyFunnelResult(null);
  }

  const ctx = await loadContext(orgId);
  const allOpps = await db
    .select()
    .from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId))
    .orderBy(desc(quoteOpportunities.requestDate));

  const nonCustomerIds = nonCustomerCustomerIdsFromMap(ctx.customerMap);
  // Compose viewer scoping with caller filters. We OR the rep filter onto
  // the existing filters so an admin can still drill into a rep view via
  // the UI filter bar, while a scoped rep cannot see anyone else.
  const effectiveFilters: QuoteFilters = scopedRepId
    ? { ...filters, repId: scopedRepId }
    : filters;
  const filtered = applyFilters(allOpps, effectiveFilters, nonCustomerIds);

  if (filtered.length === 0) {
    return emptyFunnelResult(scopedRepId ?? null);
  }

  // Look up which of the filtered quotes have a follow-up event. Done in a
  // single batched query to avoid N+1.
  const filteredIds = filtered.map(r => r.id);
  const followupRows = await db
    .select({ quoteId: quoteEvents.quoteId })
    .from(quoteEvents)
    .where(and(
      inArray(quoteEvents.quoteId, filteredIds),
      inArray(quoteEvents.eventType, FUNNEL_FOLLOWUP_EVENT_TYPES as unknown as string[]),
    ));
  const followupSet = new Set<string>(followupRows.map(r => r.quoteId));

  const now = Date.now();
  const staleMs = STALE_AGE_DAYS * 24 * 3600 * 1000;

  let received = 0;
  let quoted = 0;
  let followup = 0;
  let won = 0;
  let lost = 0;
  let stale = 0;
  let responseSum = 0;
  let responseCount = 0;
  const lossReasonAgg = new Map<string, number>();

  for (const r of filtered) {
    received++;
    const hasQuoted = num(r.quotedAmount) > 0;
    if (hasQuoted) quoted++;
    if (followupSet.has(r.id)) followup++;
    if (isWon(r.outcomeStatus)) won++;
    if (isLost(r.outcomeStatus)) {
      lost++;
      const key = r.outcomeReasonId ?? "__none__";
      lossReasonAgg.set(key, (lossReasonAgg.get(key) ?? 0) + 1);
    }
    const ageMs = now - r.requestDate.getTime();
    const isStaleByAge = r.outcomeStatus === "pending" && ageMs > staleMs;
    if (isStaleByAge || r.outcomeStatus === "no_response" || r.outcomeStatus === "expired") {
      stale++;
    }
    const rt = num(r.responseTimeHours);
    if (rt > 0) { responseSum += rt; responseCount++; }
  }

  const stages: FunnelStage[] = [
    { key: "received", label: "Request Received", count: received, conversionPct: null, shareOfReceivedPct: 100 },
    { key: "quoted", label: "Quoted", count: quoted, conversionPct: pct(quoted, received), shareOfReceivedPct: pct(quoted, received) },
    { key: "followup", label: "Follow-up Sent", count: followup, conversionPct: pct(followup, quoted), shareOfReceivedPct: pct(followup, received) },
    { key: "won", label: "Booked / Won", count: won, conversionPct: pct(won, quoted), shareOfReceivedPct: pct(won, received) },
    { key: "lost", label: "Lost", count: lost, conversionPct: pct(lost, quoted), shareOfReceivedPct: pct(lost, received) },
    { key: "stale", label: "Stale / No Response", count: stale, conversionPct: pct(stale, quoted), shareOfReceivedPct: pct(stale, received) },
  ];

  const decided = won + lost;
  const summary: FunnelSummary = {
    totalReceived: received,
    totalQuoted: quoted,
    totalWon: won,
    totalLost: lost,
    totalStale: stale,
    quoteToBookPct: pct(won, received),
    winRatePct: pct(won, decided),
    avgResponseTimeHours: responseCount > 0 ? responseSum / responseCount : 0,
    followUpCompliancePct: pct(followup, quoted),
  };

  const lossReasons: FunnelLossReason[] = Array.from(lossReasonAgg.entries())
    .map(([reasonId, count]) => {
      if (reasonId === "__none__") {
        return { reasonId: null, label: "Reason not set", count };
      }
      const reason = ctx.reasonMap.get(reasonId);
      return { reasonId, label: reason?.label ?? "Unknown", count };
    })
    .sort((a, b) => b.count - a.count);

  // Performers: bucket by lane, customer, rep. Wins / total drive ranking;
  // we surface both ends (best + worst by total) so the UI tabs can show the
  // most active and most struggling lanes/customers/reps.
  type Bucket = { id: string; label: string; total: number; won: number; lost: number; quotedSum: number };
  const laneAgg = new Map<string, Bucket>();
  const customerAgg = new Map<string, Bucket>();
  const repAgg = new Map<string, Bucket>();

  for (const r of filtered) {
    const laneKey = `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`;
    const lane = laneAgg.get(laneKey) ?? { id: laneKey, label: laneKey, total: 0, won: 0, lost: 0, quotedSum: 0 };
    lane.total++;
    if (isWon(r.outcomeStatus)) lane.won++;
    if (isLost(r.outcomeStatus)) lane.lost++;
    lane.quotedSum += num(r.quotedAmount);
    laneAgg.set(laneKey, lane);

    const cust = customerAgg.get(r.customerId) ?? {
      id: r.customerId,
      label: ctx.customerMap.get(r.customerId)?.name ?? "—",
      total: 0, won: 0, lost: 0, quotedSum: 0,
    };
    cust.total++;
    if (isWon(r.outcomeStatus)) cust.won++;
    if (isLost(r.outcomeStatus)) cust.lost++;
    cust.quotedSum += num(r.quotedAmount);
    customerAgg.set(r.customerId, cust);

    // Task #714 — skip rep buckets for any quote attributed to a rep whose
    // linked user has a non-customer-facing role (logistics_manager,
    // logistics_coordinator, generic "sales", etc.). The quote itself is
    // still counted in lane / customer / stage totals — it just doesn't
    // surface in the rep best/worst ranking. Reps without a linked user
    // (legacy / email-signature only) remain in `customerFacingRepIds`
    // and continue to aggregate normally.
    if (r.repId && ctx.customerFacingRepIds.has(r.repId)) {
      const rep = repAgg.get(r.repId) ?? {
        id: r.repId,
        label: ctx.repMap.get(r.repId)?.name ?? "—",
        total: 0, won: 0, lost: 0, quotedSum: 0,
      };
      rep.total++;
      if (isWon(r.outcomeStatus)) rep.won++;
      if (isLost(r.outcomeStatus)) rep.lost++;
      rep.quotedSum += num(r.quotedAmount);
      repAgg.set(r.repId, rep);
    }
  }

  // Materialize all rows from the bucket map. Best/worst splits are computed
  // from this FULL set so the worst column reflects true bottom performers
  // even when there are >N decided buckets (prior bug: pre-truncating to top
  // N by winRate caused worst to be the bottom of the top, not the bottom).
  function toRows(buckets: Map<string, Bucket>, minTotal: number): FunnelPerformerRow[] {
    return Array.from(buckets.values())
      .filter(b => b.total >= minTotal)
      .map(b => ({
        id: b.id,
        label: b.label,
        total: b.total,
        won: b.won,
        lost: b.lost,
        winRate: pct(b.won, b.won + b.lost),
        avgQuoted: b.total > 0 ? b.quotedSum / b.total : 0,
      }));
  }

  // Split into top-N best and bottom-N worst using winRate as the primary
  // sort and total as the tiebreaker. "Decided" rows (won+lost > 0) are the
  // only meaningful inputs for win-rate ranking; rows with zero decisions
  // would all tie at 0% and crowd out genuine low performers.
  function splitBestWorst(
    rows: FunnelPerformerRow[],
    n: number,
  ): FunnelPerformerSplit {
    const decided = rows.filter(r => r.won + r.lost > 0);
    const best = decided
      .slice()
      .sort((a, b) => b.winRate - a.winRate || b.total - a.total)
      .slice(0, n);
    // Worst = lowest winRate first, with the higher-volume bucket breaking
    // ties so a 0%/8-quote bucket ranks below a 0%/1-quote bucket.
    const worst = decided
      .slice()
      .sort((a, b) => a.winRate - b.winRate || b.total - a.total)
      .slice(0, n);
    return { best, worst };
  }

  const PERFORMER_TOP_N = 5;
  const performers: FunnelPerformers = {
    lanes: splitBestWorst(toRows(laneAgg, 1), PERFORMER_TOP_N),
    customers: splitBestWorst(toRows(customerAgg, 1), PERFORMER_TOP_N),
    reps: splitBestWorst(toRows(repAgg, 1), PERFORMER_TOP_N),
  };

  return {
    stages,
    summary,
    lossReasons,
    performers,
    scopedToRepId: scopedRepId ?? null,
  };
}
