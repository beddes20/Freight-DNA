import { and, eq, asc, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, storage } from "../storage";
import { logQuoteTouchpointFromEvent } from "./quoteTouchpoints";
import { carriers as carriersCatalog } from "@shared/schema";
import {
  quoteCustomers, quoteReps, quoteCarriers, quoteLaneGroups, quoteOutcomeReasons,
  quoteOpportunities, quoteEvents, quoteSavedViews, quoteSenderMappings,
  recurringLanes, companies, emailMessages, emailSignals,
  freightOpportunities,
  freightOpportunityCaptureFailures,
  captureLeakReviews,
  cronHeartbeats,
  type QuoteOpportunity, type QuoteOutcomeStatus, type QuoteCustomer, type QuoteRep,
  type QuoteCarrier, type QuoteLaneGroup, type QuoteOutcomeReason, type QuoteSavedView,
  type InsertFreightOpportunity,
  type FreightCaptureFailureReason,
  type CaptureLeakType, type CaptureLeakReviewDecision, type CaptureLeakReview,
} from "@shared/schema";
import { UNKNOWN_CUSTOMER_NAME, classifyPartyType, sanitizeCustomerName, isFreeMailProviderName } from "./customerNameResolver";
import { isObviousFakeCustomerName } from "@shared/fakeCustomerName";
import { organizations } from "@shared/schema";
import { loadNonCustomerCustomerIds } from "./customerOnlyChokepoint";
import { isFunnelEligibleRep, QUOTE_REP_UNIVERSE_ROLES, QUOTE_OWNER_DISPLAY_ROLES } from "@shared/quoteOpportunitiesRoles";
import { users } from "@shared/schema";
import { learnFromReassign } from "./quoteSenderMappings";
import type { QuotePartyType } from "@shared/schema";
import { getStaleQuoteFollowUps } from "./staleQuoteFollowup";
import { JOB_NAMES } from "../lib/cronHeartbeat";
import {
  LOST_INCUMBENT, LOST_PRICE, LOST_SERVICE, LOST_TIMING,
  findOrCreateLostReasonExported,
  ingestQuoteFromEmail,
  type LostReason,
} from "./quoteEmailIngestion";
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
  // Task #850 — when true, snoozed rows (snoozedUntil > now) are kept in
  // the result set. Default behaviour (undefined / false) hides them so
  // the operator surface stays focused on the active queue.
  includeSnoozed?: boolean;
};

export type EnrichedQuote = QuoteOpportunity & {
  customerName: string;
  repName: string;
  // Task #1012 — true when `repName` was projected from the linked
  // customer's `ownerRepId` because the row's own `repId` is null.
  // Lets the Quote Requests UI render an "owner" badge that
  // distinguishes a fallback display from an explicit assignment.
  // The underlying `repId` is intentionally not mutated when this
  // flag is true.
  repFromCustomerOwner: boolean;
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
  // Phase 1 — Response Time Visibility.
  // Both fields are minute-granularity, derived read-only from
  // existing data (no new ingest/classifier work):
  //   firstReplyMinutes: minutes from inbound (requestDate) to the
  //     earliest outbound message in the SAME email_messages.thread_id.
  //     Computed live in `attachResponseTimes` for the visible page.
  //     null when the source thread can't be resolved or no outbound
  //     reply exists yet.
  //   firstQuoteMinutes: existing `responseTimeHours` * 60 (rounded).
  //     Populated by the ingest pipeline when the priced reply is
  //     detected; null when no priced reply has been recorded.
  // The UI badges these against fixed SLA bands (≤15m / ≤60m).
  firstReplyMinutes: number | null;
  firstQuoteMinutes: number | null;
  // Task #1011 — owner-rep fallback. Populated when the row's
  // `repName` is empty AND the customer maps to a CRM company whose
  // `ownerRepId` resolves to a real user. The Quote Requests Rep cell
  // renders this as "<Owner Name> (owner)" so account managers see who
  // would catch the email if the inbox-recipient routing had fired.
  ownerRepName?: string | null;
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
    // Phase 1 — Response Time Visibility (read-only aggregates over the
    // existing `responseTimeHours` column; no new ingestion). Computed
    // from `won + quoted + lost` rows that have a recorded priced
    // reply time. `pctFirstQuoteUnder60` is a percent (0–100).
    avgFirstQuoteMin: number;
    pctFirstQuoteUnder60: number;
    quotedCount: number;
    // Today's email-sourced opps (post customer-only chokepoint). See
    // `automation-counters` for the leakage-path counter.
    autoCapturedToday: number;
    // Task #1003 — count of pending (and not-currently-snoozed) opps in
    // the last 7 days, computed org-wide post the customer-only
    // chokepoint, *ignoring* the request's startDate/endDate. Used by
    // the empty-state subtitle on `/quote-requests` so a quiet today
    // never reads as a dead pipeline when 7-day pending volume exists.
    pendingLast7d: number;
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

// Task #816 — `carrierPaid` / `marginDollar` / `marginPct` were retired
// when the carrier columns came off the Quote Opportunities table. The
// list endpoint still tolerates a stale saved view that requested one of
// them (the route schema accepts it; the service-level switch falls back
// to default request-date ordering) so old rows don't 400 the request.
export type ListSortKey =
  | "requestDate" | "customerName" | "originCity" | "destCity" | "equipment"
  | "quotedAmount" | "validThrough" | "outcomeStatus" | "outcomeReasonLabel"
  | "repName" | "responseTimeHours"
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

export function applyFilters(
  rows: QuoteOpportunity[],
  f: QuoteFilters,
  // Task #615 — single chokepoint for the customer-only rule. Any customer
  // whose id is in this set has `partyType !== "customer"` (carrier OR
  // unknown OR missing) and is filtered out of every aggregate driven by
  // this helper (KPIs, list, charts, taxonomy, attractiveness, CSV export).
  // The flag is hard-wired ON: there is no opt-in to surface non-customer
  // rows on the Quote Opportunities feed.
  nonCustomerCustomerIds?: Set<string>,
  // Task #1042 — second chokepoint, paired with the customer-only one.
  // When provided, drop rows whose `repId` is non-null AND not in this set
  // (i.e. attributed to a logistics_manager / logistics_coordinator /
  // generic-sales rep). Rows with `repId === null` are NOT dropped here —
  // the existing customer chokepoint and Account-Owner fallback still
  // govern their visibility, preserving Task #1012 behavior.
  customerFacingRepIds?: Set<string>,
): QuoteOpportunity[] {
  return rows.filter((r) => {
    if (nonCustomerCustomerIds && nonCustomerCustomerIds.has(r.customerId)) return false;
    // Task #1042 — routing-status gate. The Customer Quotes main queue is
    // customer-side only: the classifier already tagged carrier-side rows
    // (`auto_carrier`) and unsure rows (`needs_routing`); they must never
    // appear in the list / snapshot / funnel / CSV. The Needs Routing tab
    // queries `routing_status = 'needs_routing'` directly via its own
    // endpoint and is unaffected by this gate.
    if (r.routingStatus === "auto_carrier" || r.routingStatus === "needs_routing") return false;
    // Task #1042 — rep-role gate. Drops rows whose `repId` is non-null but
    // points at a rep that is NOT in the org's customer-facing rep set
    // (built by `loadContext` from the AM/NAM-linked + non-suppressed
    // reps). Null `repId` falls through so the customer chokepoint and
    // Account-Owner fallback (Task #1012) still govern those rows.
    if (customerFacingRepIds && r.repId && !customerFacingRepIds.has(r.repId)) return false;
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
    // Task #850 — hide currently-snoozed rows from the default view. The
    // toggle from the page (Include snoozed) flips this off so admins can
    // audit deferred work. `snoozedUntil` is nullable; rows without one
    // are never snoozed.
    if (!f.includeSnoozed && r.snoozedUntil && r.snoozedUntil.getTime() > Date.now()) {
      return false;
    }
    return true;
  });
}

// Task #816 — `loadNonCustomerCustomerIds` lives in
// ./customerOnlyChokepoint so that the satellite services
// (`staleQuoteFollowup`, etc.) share the same hardened logic without
// pulling in this module (and its circular-dependency risk).

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

/**
 * Task #1012 — set (or clear) the primary owner rep on a `quote_customers`
 * row. Returns the updated row plus the denormalized owner display name
 * (joined from `quote_reps`) so the caller can echo it back to the UI
 * without a second round-trip. Returns null when the customer doesn't
 * exist in the org.
 *
 * Validation of the rep (same org, not suppressed) is the route layer's
 * responsibility — this function performs only the persistence.
 */
export async function setQuoteCustomerOwner(
  orgId: string,
  customerId: string,
  ownerRepId: string | null,
): Promise<{ customer: QuoteCustomer; ownerRepName: string | null } | null> {
  const [row] = await db.update(quoteCustomers)
    .set({ ownerRepId })
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, customerId)))
    .returning();
  if (!row) return null;
  let ownerRepName: string | null = null;
  if (row.ownerRepId) {
    const [rep] = await db.select({ name: quoteReps.name, userName: users.name })
      .from(quoteReps)
      .leftJoin(users, eq(users.id, quoteReps.userId))
      .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, row.ownerRepId)))
      .limit(1);
    ownerRepName = (rep?.userName && rep.userName.trim()) || rep?.name || null;
  }
  return { customer: row, ownerRepName };
}

/**
 * Task #1012 — fetch a customer + its owner rep info (denormalized
 * display name). Returns null when the customer doesn't exist in the
 * org. Used by the Customer profile widget on company-detail to render
 * the current state without round-tripping through the snapshot.
 */
export async function getQuoteCustomerWithOwner(
  orgId: string,
  customerId: string,
): Promise<{ customer: QuoteCustomer; ownerRepName: string | null } | null> {
  const [customer] = await db.select().from(quoteCustomers)
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, customerId)))
    .limit(1);
  if (!customer) return null;
  let ownerRepName: string | null = null;
  if (customer.ownerRepId) {
    const [rep] = await db.select({ name: quoteReps.name, userName: users.name })
      .from(quoteReps)
      .leftJoin(users, eq(users.id, quoteReps.userId))
      .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, customer.ownerRepId)))
      .limit(1);
    ownerRepName = (rep?.userName && rep.userName.trim()) || rep?.name || null;
  }
  return { customer, ownerRepName };
}

/**
 * Task #1012 — find the `quote_customers` row in this org whose name
 * matches the given display name (case-insensitive, whitespace-tolerant)
 * — the company-detail page uses this to discover whether a CRM company
 * has a corresponding Customer Quotes record so it can surface the
 * Owner Rep widget. Returns the same shape as `getQuoteCustomerWithOwner`
 * (or null when no quote_customer matches).
 */
export async function findQuoteCustomerByName(
  orgId: string,
  name: string,
): Promise<{ customer: QuoteCustomer; ownerRepName: string | null } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [customer] = await db.select().from(quoteCustomers)
    .where(and(
      eq(quoteCustomers.organizationId, orgId),
      sql`lower(${quoteCustomers.name}) = lower(${trimmed})`,
    ))
    .limit(1);
  if (!customer) return null;
  return getQuoteCustomerWithOwner(orgId, customer.id);
}

function num(v: string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v); return isNaN(n) ? 0 : n;
}

/**
 * Customer Quotes portlet bug-fix — given the org's `quote_customers` rows
 * and `companies` rows, build a per-customer-id map of canonical display
 * names sourced from the canonical CRM `companies` table.
 *
 * The legacy `customerNameResolver.nameFromBusinessDomain` produces sluggified
 * strings like "Mohawkind" (from `mohawkind.com`) or "Armstrong" when the
 * inbound email's display name is missing — but the org often has a properly
 * named CRM record like "Mohawk Industries" or "Armstrong World Industries".
 * This map upgrades the display, conservatively, only when there's a strong
 * signal:
 *
 *   1. **Exact normalized match** — quote_customer's normalized name
 *      (alphanumeric only, lowercased) equals exactly one company's normalized
 *      name AND the displayed strings actually differ (case/whitespace).
 *   2. **Prefix-uniqueness match** — exactly one company's normalized name
 *      starts with the quote_customer's normalized name and is at least 3
 *      characters longer. This catches "Mohawkind" → "Mohawk Industries"
 *      while rejecting near-misses like "Valuetruck" → "Valuetruckaz" (only
 *      +2 chars) and ambiguous picks like "Masonite" → 3 candidate companies.
 *
 * When no rule fires, the customer is omitted from the map so the caller
 * falls back to the original `quote_customers.name`. Org-scoped by virtue
 * of the inputs being already org-scoped.
 */
export function buildCanonicalCustomerNameMap(
  customers: { id: string; name: string }[],
  companies: { name: string }[],
): Map<string, string> {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Normalized company name → unique list of canonical names.
  const companyByNorm = new Map<string, Set<string>>();
  for (const c of companies) {
    const cleaned = (c.name ?? "").trim();
    if (!cleaned) continue;
    const n = norm(cleaned);
    if (n.length < 3) continue;
    const set = companyByNorm.get(n) ?? new Set<string>();
    set.add(cleaned);
    companyByNorm.set(n, set);
  }
  const allNorms = Array.from(companyByNorm.keys());
  const minExtension = 3;
  const result = new Map<string, string>();
  for (const cust of customers) {
    const cleaned = (cust.name ?? "").trim();
    if (!cleaned) continue;
    const cn = norm(cleaned);
    if (cn.length < 3) continue;
    // Tier A — exact normalized match. Only adopt when the canonical
    // string actually reads better than the stored one (different
    // characters, not just identical). When multiple companies share
    // the same normalization, skip rather than guess.
    const exact = companyByNorm.get(cn);
    if (exact && exact.size === 1) {
      const canonical = exact.values().next().value as string;
      if (canonical !== cleaned) {
        result.set(cust.id, canonical);
        continue;
      }
    }
    // Tier B — prefix-uniqueness. The canonical name extends the
    // quote_customer's name (canonical longer by at least 3 chars).
    const matches: string[] = [];
    for (const candNorm of allNorms) {
      if (
        candNorm.length >= cn.length + minExtension &&
        candNorm.startsWith(cn)
      ) {
        const set = companyByNorm.get(candNorm);
        if (set) for (const n of set) matches.push(n);
        if (matches.length > 1) break; // ambiguous — bail early
      }
    }
    if (matches.length === 1) {
      result.set(cust.id, matches[0]);
    }
  }
  return result;
}

/**
 * Customer Quotes portlet bug-fix — Tier-1 rep resolution for email-ingested
 * quotes. The legacy `quote_reps` table has `user_id = NULL` for the vast
 * majority of email-extracted reps (the upstream `findOrCreateRep` looked up
 * the user but never persisted the linkage), so the funnel-eligibility filter
 * (Task #752) hides every such rep and the portlet renders "Unassigned".
 *
 * Stronger signal — the inbound `email_messages.to_email` is the address the
 * customer wrote to, which on this surface IS the responsible rep. Resolve
 * that address to the org's `users` table (`username` is the user's email)
 * and, when the linked user has an AM/NAM role, return their display name
 * keyed by the originating quote opportunity id. The caller then bypasses
 * the funnel-eligibility veto for those opportunities.
 *
 * Unlinked / non-customer-facing matches return nothing so the existing
 * tier-2/3/4 fallback chain runs.
 */
async function resolveRepsFromSourceEmails(
  orgId: string,
  opps: Pick<QuoteOpportunity, "id" | "source" | "sourceReference">[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const refs = Array.from(new Set(
    opps
      .filter(o => o.source === "email" && o.sourceReference)
      .map(o => o.sourceReference as string),
  ));
  if (refs.length === 0) return result;
  // The opportunity's `sourceReference` is one of {email_messages.id,
  // email_messages.provider_message_id} depending on the ingestion path
  // — match either. Org-scoped to keep tenant isolation tight. Drizzle's
  // `inArray` parameterizes the list correctly across pg drivers; the
  // earlier `ANY($1::text[])` form failed under the current pg adapter
  // ("cannot cast type record to text[]").
  const messages = await db
    .select({
      id: emailMessages.id,
      providerMessageId: emailMessages.providerMessageId,
      toEmail: emailMessages.toEmail,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      or(
        inArray(emailMessages.id, refs),
        inArray(emailMessages.providerMessageId, refs),
      ),
    ));
  if (messages.length === 0) return result;
  const toEmailByRef = new Map<string, string>();
  for (const m of messages) {
    const to = (m.toEmail ?? "").trim().toLowerCase();
    if (!to) continue;
    // The to_email column may contain a comma-separated list; the first
    // address is the primary recipient (the rep the customer wrote to).
    const primary = to.split(/[,;]/)[0]!.trim();
    if (!primary) continue;
    if (m.id) toEmailByRef.set(m.id, primary);
    if (m.providerMessageId) toEmailByRef.set(m.providerMessageId, primary);
  }
  const distinctEmails = Array.from(new Set(toEmailByRef.values()));
  if (distinctEmails.length === 0) return result;
  // Same parameterization fix — match by lowercased username via
  // Drizzle's `inArray` over a precomputed lowercased emails list, which
  // sidesteps the "ANY($1::text[])" record-cast issue. The username
  // column is already stored lowercased in this schema, but we apply
  // `lower()` to be defensive against legacy mixed-case rows.
  const linkedUsers = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .where(and(
      eq(users.organizationId, orgId),
      inArray(sql`lower(${users.username})`, distinctEmails),
    ));
  const userByEmail = new Map<string, { id: string; name: string; role: string }>();
  for (const u of linkedUsers) {
    const email = (u.username ?? "").trim().toLowerCase();
    const name = (u.name ?? "").trim();
    if (!email || !name || !u.id) continue;
    // Tier-1 resolution uses the wider DISPLAY-ONLY owner role set
    // (AM / NAM / logistics_manager / logistics_coordinator). The Customer
    // Quotes portlet shows the actual responsible person for each quote,
    // which in this brokerage includes operations owners (logistics
    // managers) on a large share of email-sourced rows. This is the ONLY
    // call site allowed to use `QUOTE_OWNER_DISPLAY_ROLES`; the
    // funnel-eligibility predicate and rep dropdown stay AM/NAM-only via
    // `QUOTE_REP_UNIVERSE_ROLES`. Suppression is enforced below.
    if (!QUOTE_OWNER_DISPLAY_ROLES.has(u.role as never)) continue;
    userByEmail.set(email, { id: u.id, name, role: u.role });
  }
  if (userByEmail.size === 0) return result;
  // Respect quote_reps.suppressed: if an admin explicitly suppressed a rep
  // that maps to one of these users (in this org), drop them from Tier-1
  // so the existing tier-2/3/4 fallback runs (which honors suppression).
  const userIds = Array.from(new Set(Array.from(userByEmail.values()).map(u => u.id)));
  if (userIds.length > 0) {
    const suppressed = await db
      .select({ userId: quoteReps.userId })
      .from(quoteReps)
      .where(and(
        eq(quoteReps.organizationId, orgId),
        eq(quoteReps.suppressed, true),
        inArray(quoteReps.userId, userIds),
      ));
    if (suppressed.length > 0) {
      const suppressedUserIds = new Set(suppressed.map(s => s.userId).filter(Boolean) as string[]);
      for (const [email, info] of Array.from(userByEmail.entries())) {
        if (suppressedUserIds.has(info.id)) userByEmail.delete(email);
      }
      if (userByEmail.size === 0) return result;
    }
  }
  for (const o of opps) {
    if (o.source !== "email" || !o.sourceReference) continue;
    const to = toEmailByRef.get(o.sourceReference);
    if (!to) continue;
    const user = userByEmail.get(to);
    if (!user) continue;
    result.set(o.id, user.name);
  }
  return result;
}

function enrich(
  rows: QuoteOpportunity[],
  customerMap: Map<string, QuoteCustomer>,
  repMap: Map<string, QuoteRep>,
  carrierMap: Map<string, QuoteCarrier>,
  reasonMap: Map<string, QuoteOutcomeReason>,
  opts: {
    now?: number;
    funnelEligibleRepIds?: Set<string>;
    /**
     * Task #837 — preferred rep display name per `quote_reps.id`,
     * built in `loadContext` from the linked `users.name` (when
     * present and non-empty). When the caller supplies this map,
     * `enrich()` resolves a rep's display name as
     *   linked-user-name → quote_reps.name → "—"
     * The bare `"—"` is the empty/Unassigned sentinel and is what
     * the frontend falls back to "Unassigned" on.
     */
    repDisplayNames?: Map<string, string>;
    /**
     * Customer Quotes portlet bug-fix — primary tier rep names keyed by
     * opportunity id, sourced from `email_messages.to_email` →
     * `users.username`. When present, this beats every other tier and
     * bypasses `funnelEligibleRepIds` hiding (the linked user is already
     * verified customer-facing inside `resolveRepsFromSourceEmails`).
     */
    repByOpportunityId?: Map<string, string>;
    /**
     * Customer Quotes portlet bug-fix — canonical customer display name
     * keyed by `quote_customers.id`, built in `loadContext` from the org's
     * `companies` table. Beats `quote_customers.name` when present so the
     * portlet stops showing sluggified strings like "Mohawkind".
     */
    canonicalCustomerNames?: Map<string, string>;
    /**
     * Task #1011 — owner-rep display name keyed by `quote_customers.id`.
     * Surfaced on `EnrichedQuote.ownerRepName` so the Quote Requests
     * Rep cell can render "<Name> (owner)" when the row has no
     * resolved rep but the customer's CRM company has an `ownerRepId`.
     */
    ownerRepNameByCustomerId?: Map<string, string>;
  } = {},
): EnrichedQuote[] {
  const now = opts.now ?? Date.now();
  const eligible = opts.funnelEligibleRepIds;
  const displayNames = opts.repDisplayNames;
  const repByOpp = opts.repByOpportunityId;
  const canonicalCust = opts.canonicalCustomerNames;
  return rows.map(r => {
    const sla = computeQuoteSla(r.requestDate, r.outcomeStatus, { now });
    // Tier-1 source-email rep beats every other signal. Linked user is
    // already verified customer-facing upstream so no extra eligibility
    // check needed here.
    let repName = "—";
    let repFromCustomerOwner = false;
    const tier1 = repByOpp?.get(r.id);
    if (tier1) {
      repName = tier1;
    } else {
      // Task #752 — when the caller passes a `funnelEligibleRepIds` set
      // (loadContext-derived AM/NAM-linked + non-suppressed reps), hide the
      // rep's display name for any quote attributed to a non-eligible rep.
      // The repId is preserved on the row so the audit page can still
      // resolve who the rep was.
      const repHidden = eligible !== undefined && r.repId !== null && r.repId !== undefined && !eligible.has(r.repId);
      if (!repHidden && r.repId) {
        const preferred = displayNames?.get(r.repId);
        repName = preferred ?? repMap.get(r.repId)?.name ?? "—";
      } else if (!r.repId) {
        // Account Owner fallback (consolidation of Task #1011 + #1012).
        // Source of truth is `companies.ownerRepId` — surfaced via
        // `ownerRepNameByCustomerId` in `loadContext` (joins
        // quote_customers → companies → users). The legacy
        // `quote_customers.owner_rep_id` column is intentionally NOT
        // read here — it's a deprecated cache kept for one release of
        // safety, but the live signal must come from the CRM master.
        const ownerName = opts.ownerRepNameByCustomerId?.get(r.customerId) ?? null;
        if (ownerName) {
          repName = ownerName;
          repFromCustomerOwner = true;
        }
      }
    }
    const stored = customerMap.get(r.customerId)?.name;
    const customerName = canonicalCust?.get(r.customerId) ?? stored ?? "—";
    // Task #1011 — only surface ownerRepName as a fallback (when the
    // row truly has no resolved rep). Avoid overriding a real rep
    // attribution; the UI then renders "<Name> (owner)" only for
    // empty rep cells.
    const ownerRepName = repName === "—"
      ? (opts.ownerRepNameByCustomerId?.get(r.customerId) ?? null)
      : null;
    return {
      ...r,
      customerName,
      repName,
      repFromCustomerOwner,
      carrierName: r.carrierId ? carrierMap.get(r.carrierId)?.name ?? null : null,
      outcomeReasonLabel: r.outcomeReasonId ? reasonMap.get(r.outcomeReasonId)?.label ?? null : null,
      slaState: sla.state,
      minutesSinceRequest: sla.minutesSinceRequest,
      // Phase 1 — read-only response-time projections.
      // firstReplyMinutes is filled later by `attachResponseTimes`
      // (visible-page batch). firstQuoteMinutes is derived directly
      // from the existing `responseTimeHours` column so no new
      // ingestion path is needed.
      firstReplyMinutes: null,
      firstQuoteMinutes: r.responseTimeHours != null && num(r.responseTimeHours) > 0
        ? Math.round(num(r.responseTimeHours) * 60)
        : null,
      ownerRepName,
    };
  });
}

async function loadContext(orgId: string) {
  // Task #714 — left-join `users` so we can hide reps whose linked user is
  // a non-customer-facing role (logistics_manager, logistics_coordinator,
  // generic "sales", etc.) from the Quote Opportunities pickers and the
  // funnel rep performance breakdown.
  //
  // Task #752 — the funnel-display predicate `isFunnelEligibleRep` is now
  // STRICT: a rep qualifies only when (a) it's linked to a user with an
  // AM/NAM role AND (b) its admin-controlled `suppressed` flag is false.
  // Unlinked reps (NULL user_id — typically extracted from an email
  // signature without ever being linked to a real user) and reps flagged
  // by an admin via the rep-audit page are excluded. The full repMap is
  // still kept so individual quote rows can resolve a display name when
  // needed elsewhere.
  const [customers, repsJoined, reasons, laneGroups, carriers, orgCompanies] = await Promise.all([
    db.select().from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)).orderBy(asc(quoteCustomers.name)),
    db
      .select({
        id: quoteReps.id,
        organizationId: quoteReps.organizationId,
        userId: quoteReps.userId,
        name: quoteReps.name,
        email: quoteReps.email,
        suppressed: quoteReps.suppressed,
        linkedUserRole: users.role,
        // Task #837 — also bring back the linked user's display name
        // so we can prefer it over `quote_reps.name` for any
        // customer-facing rep cell. The legacy `name` column on
        // quote_reps is often a stale email-signature string; the
        // linked user's name is the canonical one.
        linkedUserName: users.name,
      })
      .from(quoteReps)
      .leftJoin(users, eq(users.id, quoteReps.userId))
      .where(eq(quoteReps.organizationId, orgId))
      .orderBy(asc(quoteReps.name)),
    db.select().from(quoteOutcomeReasons).where(eq(quoteOutcomeReasons.organizationId, orgId)),
    db.select().from(quoteLaneGroups).where(eq(quoteLaneGroups.organizationId, orgId)),
    db.select().from(quoteCarriers).where(eq(quoteCarriers.organizationId, orgId)),
    // Customer Quotes portlet bug-fix — fetch the org's `companies` (just
    // id+name needed for the canonical map) so `enrich()` can upgrade
    // sluggified quote_customers display names like "Mohawkind" to the
    // canonical CRM name "Mohawk Industries". Light query — companies
    // tables in this app stay in the low hundreds per org.
    db.select({ id: companies.id, name: companies.name, ownerRepId: companies.ownerRepId }).from(companies).where(eq(companies.organizationId, orgId)),
  ]);
  // Task #1011 — preload user display names so the owner-rep fallback
  // can render "<Name> (owner)" without per-row lookups.
  const orgUsers = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.organizationId, orgId));
  const userNameById = new Map<string, string>(orgUsers.map(u => [u.id, u.name]));
  // `allReps` powers `repMap` so individual quote rows can still resolve a
  // rep's display name even when that rep is hidden from the dropdowns.
  // `reps` is the public-facing list returned to the client (snapshot.reps)
  // and is filtered to funnel-eligible reps only (Task #752).
  const allReps: QuoteRep[] = repsJoined.map(({ linkedUserRole: _r, linkedUserName: _n, ...rest }) => rest);
  const customerFacingReps: QuoteRep[] = repsJoined
    .filter(r => isFunnelEligibleRep({ linkedUserRole: r.linkedUserRole, suppressed: r.suppressed }))
    .map(({ linkedUserRole: _r, linkedUserName: _n, ...rest }) => rest);
  const customerFacingRepIds = new Set<string>(customerFacingReps.map(r => r.id));
  // Task #837 — preferred display name per rep (linked-user-name wins
  // over the legacy `quote_reps.name`). Empty string entries are
  // dropped so `repDisplayNames.get()` returning undefined naturally
  // falls through to the `quote_reps.name` fallback in `enrich()`.
  const repDisplayNames = new Map<string, string>();
  for (const r of repsJoined) {
    const linked = (r.linkedUserName ?? "").trim();
    const legacy = (r.name ?? "").trim();
    const display = linked || legacy;
    if (display) repDisplayNames.set(r.id, display);
  }
  // Customer Quotes portlet bug-fix — canonical customer name map. Built
  // once per loadContext call and shared across all enrich() callers in
  // the request.
  const canonicalCustomerNames = buildCanonicalCustomerNameMap(customers, orgCompanies);
  // Task #1011 — customerId → owner-rep display name. Reuses the
  // canonical-name map to bridge `quote_customers` to the CRM
  // `companies` row, then resolves `ownerRepId` to the user name via
  // `userNameById`. Empty when no chain resolves.
  const ownerRepNameByCustomerId = new Map<string, string>();
  const companyByName = new Map<string, { ownerRepId: string | null }>();
  for (const co of orgCompanies) {
    if (co.name) companyByName.set(co.name, { ownerRepId: co.ownerRepId ?? null });
  }
  for (const cust of customers) {
    const canonical = canonicalCustomerNames.get(cust.id) ?? cust.name;
    const co = companyByName.get(canonical);
    if (!co?.ownerRepId) continue;
    const display = userNameById.get(co.ownerRepId);
    if (display) ownerRepNameByCustomerId.set(cust.id, display);
  }
  return {
    customers,
    // Public rep list (snapshot.reps consumes this directly).
    reps: customerFacingReps,
    reasons, laneGroups, carriers,
    customerMap: new Map(customers.map(c => [c.id, c])),
    // repMap retains every rep so name lookups in list rows / drawers /
    // funnel-bucket labels still resolve for legacy / hidden rows.
    repMap: new Map(allReps.map(r => [r.id, r])),
    repDisplayNames,
    reasonMap: new Map(reasons.map(r => [r.id, r])),
    carrierMap: new Map(carriers.map(c => [c.id, c])),
    // Set used by the funnel performers aggregation to drop quotes
    // attributed to a non-customer-facing rep from the best/worst rep
    // ranking. The underlying quote rows are unaffected.
    customerFacingRepIds,
    canonicalCustomerNames,
    ownerRepNameByCustomerId,
  };
}

export async function listQuotes(orgId: string, filters: QuoteFilters, sortKey: ListSortKey, sortDir: "asc" | "desc", offset: number, limit: number): Promise<ListResult> {
  // Task #597 — fire-and-forget classifier so unknown rows are graded into
  // customer/carrier without blocking the response.
  maybeBackfillPartyTypesAsync(orgId);
  const ctx = await loadContext(orgId);
  const all = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));
  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);
  // Task #837 — also exclude "orphan" rows whose `customerId` does not
  // resolve to any `quote_customers` row in the org's customer map.
  // These appear when a customer record was deleted (or never created)
  // but the opportunity row was kept; they have no reachable customer
  // name and would otherwise render as a bare em-dash on the portlet.
  // Union with `nonCustomerIds` so the same applyFilters chokepoint
  // drops them — keeping `list.total` consistent with the rendered
  // rows. Scoped to this list path; other consumers handle missing
  // customers their own way.
  const exclusionIds = new Set<string>(nonCustomerIds);
  for (const r of all) {
    if (!ctx.customerMap.has(r.customerId)) exclusionIds.add(r.customerId);
  }
  const filtered = applyFilters(all, filters, exclusionIds, ctx.customerFacingRepIds);
  // Customer Quotes portlet bug-fix — Tier-1 rep resolution from
  // `email_messages.to_email`. Built per-request because it depends on the
  // page's specific opportunities, not the org-level context.
  const repByOpportunityId = await resolveRepsFromSourceEmails(orgId, filtered);
  const enriched = enrich(filtered, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, {
    funnelEligibleRepIds: ctx.customerFacingRepIds,
    repDisplayNames: ctx.repDisplayNames,
    repByOpportunityId,
    canonicalCustomerNames: ctx.canonicalCustomerNames,
    ownerRepNameByCustomerId: ctx.ownerRepNameByCustomerId,
  });

  const dir = sortDir === "asc" ? 1 : -1;
  enriched.sort((a, b) => {
    let av: number | string = "";
    let bv: number | string = "";
    // Task #816 — `carrierPaid`, `marginDollar`, `marginPct` were retired
    // when carrier columns were stripped from this surface. They're no
    // longer in `ListSortKey`, but a stale saved view that still requests
    // one falls through this switch and gets the default (request-date)
    // ordering instead of crashing the request.
    switch (sortKey) {
      case "requestDate":
        av = a.requestDate.getTime(); bv = b.requestDate.getTime(); break;
      case "validThrough":
        av = a.validThrough ? a.validThrough.getTime() : 0;
        bv = b.validThrough ? b.validThrough.getTime() : 0; break;
      case "quotedAmount": av = num(a.quotedAmount); bv = num(b.quotedAmount); break;
      case "responseTimeHours": av = num(a.responseTimeHours); bv = num(b.responseTimeHours); break;
      case "score": av = num(a.score); bv = num(b.score); break;
      case "customerName": av = a.customerName.toLowerCase(); bv = b.customerName.toLowerCase(); break;
      case "originCity": av = `${a.originCity},${a.originState}`.toLowerCase(); bv = `${b.originCity},${b.originState}`.toLowerCase(); break;
      case "destCity": av = `${a.destCity},${a.destState}`.toLowerCase(); bv = `${b.destCity},${b.destState}`.toLowerCase(); break;
      case "equipment": av = a.equipment.toLowerCase(); bv = b.equipment.toLowerCase(); break;
      case "outcomeStatus": av = a.outcomeStatus; bv = b.outcomeStatus; break;
      case "outcomeReasonLabel": av = (a.outcomeReasonLabel ?? "").toLowerCase(); bv = (b.outcomeReasonLabel ?? "").toLowerCase(); break;
      case "repName": av = a.repName.toLowerCase(); bv = b.repName.toLowerCase(); break;
      case "source": av = a.source; bv = b.source; break;
      default:
        av = a.requestDate.getTime(); bv = b.requestDate.getTime(); break;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const page = enriched.slice(offset, offset + limit);
  await attachSourceThreads(orgId, page);
  await attachResponseTimes(orgId, page);
  return {
    rows: page,
    total: enriched.length,
    offset, limit,
  };
}

/**
 * Phase 1 — Response Time Visibility.
 *
 * Populates `firstReplyMinutes` for each row in the visible page by
 * batch-querying `email_messages` for the earliest outbound message in
 * the same `thread_id` after the inbound (requestDate). Strictly
 * read-only — no new ingestion / classifier / webhook plumbing.
 *
 * Constraints:
 *   - Bounded N: only runs for rows that already have `sourceThreadId`
 *     attached (typically email-sourced rows on a 50-row page).
 *   - Single grouped query per call (one `thread_id IN (…)` lookup).
 *   - Falls through silently when no thread / no outbound found.
 *
 * `firstQuoteMinutes` is set in `enrich` from the existing
 * `responseTimeHours` column and is NOT touched here.
 */
async function attachResponseTimes(orgId: string, rows: EnrichedQuote[]): Promise<void> {
  const threadIds = Array.from(new Set(
    rows.map(r => r.sourceThreadId).filter((t): t is string => !!t),
  ));
  if (threadIds.length === 0) return;
  const inList = sql.join(threadIds.map(t => sql`${t}`), sql`, `);
  const result = await db.execute<{
    thread_id: string;
    first_outbound_at: Date | string | null;
  }>(sql`
    SELECT thread_id,
           MIN(COALESCE(provider_sent_at, created_at)) AS first_outbound_at
      FROM email_messages
     WHERE org_id = ${orgId}
       AND direction = 'outbound'
       AND thread_id IN (${inList})
     GROUP BY thread_id
  `);
  const byThread = new Map<string, Date>();
  for (const r of result.rows) {
    if (r.first_outbound_at) {
      byThread.set(r.thread_id, new Date(r.first_outbound_at as string | Date));
    }
  }
  for (const r of rows) {
    if (!r.sourceThreadId) continue;
    const firstOut = byThread.get(r.sourceThreadId);
    if (!firstOut) continue;
    const inboundMs = r.requestDate.getTime();
    const deltaMin = Math.round((firstOut.getTime() - inboundMs) / 60_000);
    // Negative deltas can happen when the priced reply was logged
    // ahead of the inbound (clock skew, or replies imported via
    // self-heal before the inbound). Drop them rather than show a
    // misleading negative reply time.
    if (deltaMin >= 0) r.firstReplyMinutes = deltaMin;
  }
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

  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);

  const pending = all.filter(r =>
    r.outcomeStatus === "pending" && !nonCustomerIds.has(r.customerId)
  );

  // Customer Quotes portlet bug-fix — same Tier-1 rep + canonical-name
  // wiring as listQuotes so the SLA strip stops showing "Unassigned" for
  // email-ingested quotes whose to_email maps to a real customer-facing
  // user.
  const repByOpportunityId = await resolveRepsFromSourceEmails(orgId, pending);
  const enriched = enrich(pending, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, {
    now,
    funnelEligibleRepIds: ctx.customerFacingRepIds,
    repDisplayNames: ctx.repDisplayNames,
    repByOpportunityId,
    canonicalCustomerNames: ctx.canonicalCustomerNames,
    ownerRepNameByCustomerId: ctx.ownerRepNameByCustomerId,
  });

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
  await attachResponseTimes(orgId, merged);

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

// ─── Task #723: manual mark-outcome (rep inline action on Freight Capture) ───
//
// Mirrors what the auto-detectors (TMS sync + email classifier) do when they
// flip a pending quote: update outcomeStatus, attach a reason, write a typed
// quote_event (manual_won / manual_lost) and log a customer-facing
// touchpoint. Idempotent — bails when the quote is already in a terminal
// status (would otherwise overwrite history).

export type ManualMarkOutcomeStatus = Extract<
  QuoteOutcomeStatus,
  "won" | "won_low_margin" | "lost_price" | "lost_service" | "lost_timing" | "lost_incumbent" | "no_response"
>;

export interface MarkOutcomeResult {
  // "forbidden" — caller is rep-scoped and the quote isn't theirs.
  // "invalid_reason" — caller passed an outcomeReasonId that doesn't exist
  //   in this org. Distinguished from a generic 400 so the route can return
  //   a precise error and the caller can re-fetch the reasons list.
  status: "updated" | "already_terminal" | "not_found" | "forbidden" | "invalid_reason";
  quoteId: string;
  outcomeStatus?: QuoteOutcomeStatus;
  outcomeReasonId?: string | null;
}

export interface MarkQuoteOutcomeOptions {
  /**
   * When set, restricts the operation to quotes owned by this rep id. Used
   * by the route to enforce per-rep authorization for scoped roles
   * (account_manager, logistics_manager, logistics_coordinator). Undefined
   * means "no rep restriction" — admins/directors/national_account_managers.
   */
  enforceRepScope?: string;
  /**
   * Task #803 (C) — autopilot variant. When the no-response sweep closes a
   * quote, it routes through this same canonical write path so all the
   * normal side effects (status update, reason resolution, touchpoint log)
   * fire — but it overrides the event type from `manual_lost` to
   * `auto_lost` and merges in extra payload diagnostics (timeout hours,
   * last event metadata) so the event log honestly attributes the close to
   * the cron rather than a rep. Production callers omit these.
   */
  eventTypeOverride?: string;
  payloadExtras?: Record<string, unknown>;
}

export async function markQuoteOutcome(
  orgId: string,
  quoteId: string,
  outcomeStatus: ManualMarkOutcomeStatus,
  outcomeReasonId: string | null,
  actor: string,
  opts?: MarkQuoteOutcomeOptions,
): Promise<MarkOutcomeResult> {
  const [opp] = await db.select().from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    eq(quoteOpportunities.id, quoteId),
  )).limit(1);
  if (!opp) return { status: "not_found", quoteId };

  // Per-rep authorization (Task #723 review fix). Rep-scoped users may
  // only mark their own quotes; bail before any writes if the caller is
  // scoped and the row belongs to a different rep. Returning "forbidden"
  // (vs "not_found") lets the route surface a precise 403 — but we only
  // do this *after* the org match so we never reveal the existence of a
  // quote in another org.
  if (opts?.enforceRepScope && opp.repId !== opts.enforceRepScope) {
    return { status: "forbidden", quoteId };
  }

  // Idempotency: never overwrite a terminal status. Lets a rep harmlessly
  // re-click the same action without us re-firing the touchpoint.
  // Task #803 — `quoted` is an intermediate (non-terminal) state; manual
  // close actions (Mark Won / Mark Lost) and the no-response sweep must
  // be allowed to transition out of it just like out of `pending`.
  if (opp.outcomeStatus !== "pending" && opp.outcomeStatus !== "quoted") {
    return { status: "already_terminal", quoteId, outcomeStatus: opp.outcomeStatus as QuoteOutcomeStatus };
  }

  // The reason is required for losses and ignored for wins (the won_low_margin
  // tier is decided by margin math elsewhere — manual won maps to plain "won").
  const isWonStatus = outcomeStatus === "won" || outcomeStatus === "won_low_margin";
  const eventType = opts?.eventTypeOverride ?? (isWonStatus ? "manual_won" : "manual_lost");

  // ── Loss-reason resolution (Task #723 review fix) ────────────────────────
  // The UI used to send `outcomeReasonId: null` even for lost_* statuses,
  // which left the row with no reason and collapsed the "Why we lose"
  // breakdown into "Reason not set". Resolve a real reason row here so
  // manual losses participate in the same aggregation as auto-detected
  // ones (which use `findOrCreateLostReason` from quoteEmailIngestion):
  //   - If the caller passed an explicit ID, validate it belongs to this
  //     org and return "invalid_reason" if not (so the route can 400 cleanly).
  //   - Otherwise, when the status maps to a known LOST_* code, look it up
  //     (or create it) by code so the row always lands with a real id.
  //   - For "no_response" (which is a non-canonical loss), null is OK —
  //     it has its own stage in the funnel.
  let resolvedReasonId: string | null = null;
  if (!isWonStatus) {
    if (outcomeReasonId) {
      const [reasonRow] = await db.select().from(quoteOutcomeReasons).where(and(
        eq(quoteOutcomeReasons.organizationId, orgId),
        eq(quoteOutcomeReasons.id, outcomeReasonId),
      )).limit(1);
      if (!reasonRow) return { status: "invalid_reason", quoteId };
      resolvedReasonId = reasonRow.id;
    } else if (outcomeStatus !== "no_response") {
      const canonical = CANONICAL_LOST_REASON_BY_STATUS[outcomeStatus];
      if (canonical) {
        resolvedReasonId = await findOrCreateLostReasonExported(orgId, canonical);
      }
    }
  }

  await db.update(quoteOpportunities).set({
    outcomeStatus,
    outcomeReasonId: isWonStatus ? null : resolvedReasonId,
  }).where(eq(quoteOpportunities.id, opp.id));

  const occurredAt = new Date();
  const [ev] = await db.insert(quoteEvents).values({
    quoteId: opp.id,
    eventType,
    occurredAt,
    actor,
    payload: {
      source: "manual",
      previousStatus: opp.outcomeStatus,
      newStatus: outcomeStatus,
      outcomeReasonId: isWonStatus ? null : resolvedReasonId,
      ...(opts?.payloadExtras ?? {}),
    },
  }).returning();

  await logQuoteTouchpointFromEvent({
    orgId, oppId: opp.id, eventId: ev.id,
    eventType: ev.eventType, occurredAt: ev.occurredAt,
  });

  return { status: "updated", quoteId: opp.id, outcomeStatus, outcomeReasonId: resolvedReasonId };
}

// Status → canonical LostReason mapping. Drives the auto-resolve branch in
// markQuoteOutcome above so the manual mark-outcome path lands on the same
// reason rows the email/TMS auto-detectors create.
const CANONICAL_LOST_REASON_BY_STATUS: Partial<Record<ManualMarkOutcomeStatus, LostReason>> = {
  lost_price: LOST_PRICE,
  lost_service: LOST_SERVICE,
  lost_timing: LOST_TIMING,
  lost_incumbent: LOST_INCUMBENT,
};

export async function getSnapshot(orgId: string, filters: QuoteFilters): Promise<Snapshot> {
  // Task #597 — see listQuotes; lazy classifier keeps the snapshot honest
  // without paying the cost on every request.
  maybeBackfillPartyTypesAsync(orgId);
  const ctx = await loadContext(orgId);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId))
    .orderBy(desc(quoteOpportunities.requestDate));

  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);
  const filtered = applyFilters(allOpps, filters, nonCustomerIds, ctx.customerFacingRepIds);
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

  // Phase 1 — Response Time Visibility (Snapshot aggregates).
  // Read-only: derived from the existing `responseTimeHours` column
  // populated by ingest. We only count rows that have a recorded
  // priced-reply time (responseTimeHours > 0); pending rows where
  // we never replied are excluded so a quiet day doesn't read as
  // "0 minute average". Percentages over the same denominator.
  const withQuoteTime = filtered.filter(r => num(r.responseTimeHours) > 0);
  const quotedCount = withQuoteTime.length;
  const avgFirstQuoteMin = quotedCount > 0
    ? withQuoteTime.reduce((s, r) => s + num(r.responseTimeHours) * 60, 0) / quotedCount
    : 0;
  const pctFirstQuoteUnder60 = quotedCount > 0
    ? (withQuoteTime.filter(r => num(r.responseTimeHours) * 60 <= 60).length / quotedCount) * 100
    : 0;

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

  // Task #803 — Quote Lifecycle Autopilot daily summary alert. Counts
  // every quote_event whose actor begins with "auto:" in the last 24h
  // so the Operational Alerts rail can show one consolidated line:
  // "Autopilot last 24h — 4 new-contact prompts, 2 auto-quoted, 1
  // auto-closed". Cheap query (single quote_events scan with org join);
  // wrapped in a try/catch so a slow/missing index never breaks the
  // snapshot.
  try {
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const autopilotRows = await db
      .select({ actor: quoteEvents.actor })
      .from(quoteEvents)
      .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        sql`${quoteEvents.occurredAt} >= ${since}`,
        sql`${quoteEvents.actor} LIKE 'auto:%'`,
      ));
    let newSender = 0, outboundReply = 0, noResponse = 0;
    for (const r of autopilotRows) {
      if (r.actor === "auto:new_sender") newSender += 1;
      else if (r.actor === "auto:outbound_reply") outboundReply += 1;
      else if (r.actor === "auto:no_response_timeout") noResponse += 1;
    }
    // Surface a count of pending new-contact prompts even when the last
    // 24h has been quiet — that's the action item users need to clear.
    // Task #816 — exclude carrier-classified rows from the prompt count
    // so the customer-only Operational Alerts rail never advertises a
    // carrier mention.
    const pendingPromptsRows = await db
      .select({ id: quoteOpportunities.id, customerId: quoteOpportunities.customerId })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        sql`${quoteOpportunities.needsNewContactReview} IS NOT NULL`,
      ));
    const pendingPrompts = pendingPromptsRows.filter(r => !nonCustomerIds.has(r.customerId)).length;
    const totalAuto = newSender + outboundReply + noResponse + pendingPrompts;
    if (totalAuto > 0) {
      const parts: string[] = [];
      if (pendingPrompts > 0) parts.push(`${pendingPrompts} new-contact prompt${pendingPrompts === 1 ? "" : "s"}`);
      if (outboundReply > 0) parts.push(`${outboundReply} auto-quoted`);
      if (noResponse > 0) parts.push(`${noResponse} auto-closed (no reply)`);
      if (newSender > 0) parts.push(`${newSender} auto-tagged inbound`);
      alerts.push({
        id: "autopilot-summary",
        severity: pendingPrompts > 0 ? "medium" : "low",
        type: "autopilot_summary",
        title: "Quote autopilot — last 24h",
        detail: parts.join(" · "),
      });
    }
  } catch (err) {
    console.error("[customer-quotes] autopilot summary error:", err);
  }

  // Pattern-shift alerts (Task #481) — surfaced from the persisted detector.
  // Honor the customer filter so the panel stays scoped to the active slice.
  // Task #816 — never surface a pattern-shift alert that points at a
  // carrier/unknown customer; the Quote Opportunities page is customer-only.
  try {
    const patternAlerts = await getActivePatternAlertsForOrg(orgId);
    const startDate = new Date(now.getTime() - 30 * dayMs).toISOString().slice(0, 10);
    for (const pa of patternAlerts) {
      if (filters.customerId && pa.customerId !== filters.customerId) continue;
      if (nonCustomerIds.has(pa.customerId)) continue;
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
  // Task #816 — pre-filter to customer-only rows so a misclassified
  // carrier never appears in a "X losses in a row" alert.
  const streakOpps = nonCustomerIds.size > 0
    ? allOpps.filter(o => !nonCustomerIds.has(o.customerId))
    : allOpps;
  const streakAlerts = computeLostStreakAlerts(streakOpps, ctx.customerMap, new Map(ctx.laneGroups.map(lg => [lg.id, lg])));
  for (const sa of streakAlerts) alerts.push(sa.alert);

  // Org-wide today's auto-captured count (post customer-only chokepoint).
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const autoCapturedToday = allOpps.filter((o) =>
    !nonCustomerIds.has(o.customerId)
    && (o.source === "email" || o.source === "email_signal")
    && o.requestDate.getTime() >= dayStart.getTime(),
  ).length;

  // Task #1003 — Org-wide pending count over the last 7 rolling days,
  // computed off `allOpps` so it never depends on the request's
  // startDate/endDate filter. Mirrors the customer-only chokepoint and
  // hides currently-snoozed rows so the "honest zero-state" subtitle on
  // the Customer Quotes page reflects work the rep can actually act on.
  const sevenDaysAgo = now.getTime() - 7 * dayMs;
  const nowMs = now.getTime();
  const pendingLast7d = allOpps.filter((o) =>
    !nonCustomerIds.has(o.customerId)
    && o.outcomeStatus === "pending"
    && o.requestDate.getTime() >= sevenDaysAgo
    && !(o.snoozedUntil && o.snoozedUntil.getTime() > nowMs),
  ).length;

  return {
    total,
    kpis: {
      total, won: won.length, lost: lost.length, winRate, avgQuoted, avgCarrierCost,
      avgMarginDollar, avgMarginPct, avgResponseTime, pending: pending.length, expiringSoon,
      avgFirstQuoteMin, pctFirstQuoteUnder60, quotedCount,
      autoCapturedToday,
      pendingLast7d,
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

// Auto-flip context for a single email_won/email_lost/tms_won/tms_lost event,
// keyed by quote_event.id. Lets the drawer's timeline answer "what triggered
// this Won/Lost auto-flip" — matched phrase + email body excerpt + a link
// back to the Conversations thread.
export type QuoteOutcomeFlipContext = {
  source: "email" | "tms";
  matchedPhrase: string | null;
  bodyExcerpt: string | null;
  emailSubject: string | null;
  fromEmail: string | null;
  threadId: string | null;
  messageId: string | null;
  reasonCode: string | null;
  matchTier: string | null;
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
  // Auto-flip context keyed by quote_event.id. Empty when the quote has no
  // email_won/email_lost/tms_won/tms_lost events. The drawer's timeline
  // uses this to surface "AI flipped this to Won because the customer
  // wrote 'go ahead and book it'".
  outcomeFlipContext: Record<string, QuoteOutcomeFlipContext>;
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
  const outcomeFlipContext = await loadOutcomeFlipContext(orgId, events);
  return {
    opp, events, customer, rep, carrier, reason,
    relatedSameLane: sameLane.filter(r => r.id !== quoteId),
    relatedSameCustomer: sameCustomer.filter(r => r.id !== quoteId),
    relatedSameLaneGroup: sameLaneGroup.filter(r => r.id !== quoteId && r.originCity !== opp.originCity),
    lwqLaneId: lwqLane?.laneId ?? null,
    sourceMessage,
    outcomeFlipContext,
  };
}

/**
 * Build per-event flip context for the drawer's timeline. For each
 * email_won / email_lost event we look up the triggering email_messages
 * row by payload.messageId and attach a 240-char body excerpt + the matched
 * phrase so reps can see exactly which words tripped the auto-flip. For
 * tms_won / tms_lost we surface the match tier from payload (no email
 * lookup needed). Returns an empty record when the quote has no flip
 * events — keeps the drawer rendering trivial.
 */
const FLIP_EVENT_TYPES = new Set(["email_won", "email_lost", "tms_won", "tms_lost"]);
const BODY_EXCERPT_MAX = 240;

async function loadOutcomeFlipContext(
  orgId: string,
  events: typeof quoteEvents.$inferSelect[],
): Promise<Record<string, QuoteOutcomeFlipContext>> {
  const flipEvents = events.filter(e => FLIP_EVENT_TYPES.has(e.eventType));
  if (flipEvents.length === 0) return {};

  // Collect referenced email message ids across all email_won/email_lost
  // events in one batch (avoids N round-trips for quotes with multi-flip
  // history, e.g. AI flipped to Won then a rep marked Lost manually).
  const messageIds = new Set<string>();
  for (const e of flipEvents) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const mid = typeof payload.messageId === "string" ? payload.messageId : null;
    if (mid) messageIds.add(mid);
  }

  let messagesById = new Map<string, typeof emailMessages.$inferSelect>();
  if (messageIds.size > 0) {
    const rows = await db.select().from(emailMessages).where(and(
      eq(emailMessages.orgId, orgId),
      inArray(emailMessages.id, Array.from(messageIds)),
    ));
    messagesById = new Map(rows.map(r => [r.id, r]));
  }

  const out: Record<string, QuoteOutcomeFlipContext> = {};
  for (const e of flipEvents) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const isEmail = e.eventType === "email_won" || e.eventType === "email_lost";
    const isTms = e.eventType === "tms_won" || e.eventType === "tms_lost";
    const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
    const msg = messageId ? messagesById.get(messageId) ?? null : null;

    // Matched phrase preference: explicit `matchedPhrase` (lost path), then
    // `winLanguage` / `lossLanguage` (LLM-extracted hint), else null.
    const matchedPhrase = pickStringField(payload, ["matchedPhrase", "winLanguage", "win_language", "wonLanguage", "won_language", "lossLanguage", "loss_language"]);
    const reasonCode = pickStringField(payload, ["reasonCode", "reason_code"]);
    const matchTier = pickStringField(payload, ["matchTier", "match_tier"]);

    out[e.id] = {
      source: isEmail ? "email" : "tms",
      matchedPhrase,
      bodyExcerpt: msg?.body ? truncateBody(msg.body) : null,
      emailSubject: msg?.subject ?? null,
      fromEmail: msg?.fromEmail ?? null,
      threadId: (msg?.threadId ?? (typeof payload.threadId === "string" ? payload.threadId : null)) ?? null,
      messageId,
      reasonCode,
      matchTier: isTms ? matchTier : null,
    };
  }
  return out;
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function truncateBody(s: string): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= BODY_EXCERPT_MAX) return cleaned;
  return cleaned.slice(0, BODY_EXCERPT_MAX - 1) + "…";
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
  const trimmed = rawName.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Customer name is required");
  if (trimmed.length > 120) throw new Error("Customer name is too long");
  // Task #753 — manual-entry chokepoint runs through the same safety net
  // as the email ingestion path. A rep typing "Gmail" / "yahoo.com" into
  // the inline reassign popover lands in the shared
  // "Unknown — needs review" bucket instead of forking a provider-named
  // customer row onto the dashboard.
  const name = sanitizeCustomerName(trimmed);
  const [existing] = await db.select().from(quoteCustomers).where(and(
    eq(quoteCustomers.organizationId, orgId),
    sql`lower(${quoteCustomers.name}) = lower(${name})`,
  )).limit(1);
  if (existing) return existing;
  // Task #597 — auto-classify on insert. The dashboard's reassign popover
  // calls this for net-new "real" customers, so default to `customer` when
  // the name doesn't look like a carrier.
  const partyType = classifyPartyType({ name });
  // Task #753 — when sanitization rebucketed the rep's input into the
  // shared Unknown bucket, persist the row as `unknown` partyType so the
  // standard "non-customer" filter keeps it off the customer feed.
  const isUnknownBucket = name === UNKNOWN_CUSTOMER_NAME;
  const finalPartyType: QuotePartyType = isUnknownBucket
    ? "unknown"
    : (partyType === "unknown" ? "customer" : partyType);
  const [row] = await db.insert(quoteCustomers)
    .values({
      organizationId: orgId,
      name,
      segment: segment && segment.trim() ? segment.trim().slice(0, 80) : null,
      partyType: finalPartyType,
    })
    .returning();
  return row;
}

export async function listSavedViews(orgId: string): Promise<QuoteSavedView[]> {
  return db.select().from(quoteSavedViews)
    .where(eq(quoteSavedViews.organizationId, orgId))
    .orderBy(desc(quoteSavedViews.createdAt));
}

// Task #863 polish — `filters` is stored as an opaque jsonb blob and
// only consumed by the /quote-requests UI, which uses a wider key set
// (status / age / freeEmailOnly / domainFilter / search / pastSlaOnly)
// than the LIST query's QuoteFilters. Accepting Record<string, unknown>
// keeps save → reload lossless without forcing the route layer to map
// every UI key into QuoteFilters.
export async function createSavedView(orgId: string, userId: string, name: string, filters: Record<string, unknown>): Promise<QuoteSavedView> {
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

// Task #863 — Manage Views: rename and/or update filter shape on a
// user-saved view. Creator-scoped (a rep can only edit their own
// views; org-scoped views are still admin-managed elsewhere). Returns
// null when the row doesn't exist or belongs to another user so the
// route can answer 404.
export async function updateSavedView(
  orgId: string, userId: string, id: string,
  patch: { name?: string; filters?: Record<string, unknown> },
): Promise<QuoteSavedView | null> {
  const next: Partial<typeof quoteSavedViews.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.filters !== undefined) next.filters = patch.filters;
  if (Object.keys(next).length === 0) {
    const [existing] = await db.select().from(quoteSavedViews).where(and(
      eq(quoteSavedViews.organizationId, orgId),
      eq(quoteSavedViews.id, id),
      eq(quoteSavedViews.userId, userId),
    )).limit(1);
    return existing ?? null;
  }
  const [row] = await db.update(quoteSavedViews).set(next)
    .where(and(
      eq(quoteSavedViews.organizationId, orgId),
      eq(quoteSavedViews.id, id),
      eq(quoteSavedViews.userId, userId),
    ))
    .returning();
  return row ?? null;
}

export function quotesToCsv(quotes: EnrichedQuote[]): string {
  // Task #816 — carrier cost / margin columns are intentionally absent
  // here because the Quote Opportunities surface (table + export +
  // drawer) is customer-only. Margin data is preserved in the database
  // for other surfaces (LWQ, etc.) but never exported through this CSV.
  const headers = [
    "Request Date", "Customer", "Origin", "Destination", "Equipment",
    "Quoted Amount", "Valid Through", "Outcome Status", "Outcome Reason",
    "Rep", "Response Time (h)", "Source", "Score",
  ];
  const rows = quotes.map(q => {
    const quoted = num(q.quotedAmount);
    return [
      q.requestDate ? new Date(q.requestDate).toISOString().slice(0, 10) : "",
      q.customerName, `${q.originCity}, ${q.originState}`, `${q.destCity}, ${q.destState}`,
      q.equipment, quoted ? quoted.toFixed(2) : "",
      q.validThrough ? new Date(q.validThrough).toISOString().slice(0, 10) : "",
      q.outcomeStatus, q.outcomeReasonLabel ?? "",
      q.repName, num(q.responseTimeHours).toFixed(1),
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
  // Task #968 — Convert-to-quote handoff from the Conversations detail
  // pane. When provided, the create path resolves the most recent inbound
  // message on the thread (org-scoped) and stamps `source = "email"` +
  // `sourceReference = <message.id>` so the resulting opp shows up in
  // `attachSourceThreads` with a working "Open in Conversations"
  // deep-link. Mutually compatible with explicit source/sourceReference:
  // an explicit pair wins, the thread fallback only fills blanks.
  sourceThreadId?: string | null;
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
// Phase A5 — write a row into freight_opportunity_capture_failures every
// time the converter aborts a won quote without producing a freight opp.
// Open-failure dedupe: the partial unique index on (org_id, quote_id)
// WHERE resolved_at IS NULL means a second failure for the same quote
// updates the existing row (retryCount++) instead of spawning duplicates.
// Logging itself is best-effort — we never let a bookkeeping failure
// retract a real domain decision the caller already made.
export async function recordCaptureFailure(
  orgId: string,
  quoteId: string,
  reason: FreightCaptureFailureReason,
  detail: string | null,
  err?: unknown,
): Promise<void> {
  try {
    const errorMessage = err instanceof Error
      ? err.message
      : err == null
        ? null
        : String(err);
    const errorStack = err instanceof Error ? err.stack ?? null : null;
    await db.execute(sql`
      INSERT INTO freight_opportunity_capture_failures
        (org_id, quote_id, reason, detail, error_message, error_stack, attempted_at, retry_count)
      VALUES
        (${orgId}, ${quoteId}, ${reason}, ${detail}, ${errorMessage}, ${errorStack}, now(), 0)
      ON CONFLICT (org_id, quote_id) WHERE resolved_at IS NULL
      DO UPDATE SET
        reason = EXCLUDED.reason,
        detail = EXCLUDED.detail,
        error_message = EXCLUDED.error_message,
        error_stack = EXCLUDED.error_stack,
        attempted_at = now(),
        retry_count = freight_opportunity_capture_failures.retry_count + 1,
        last_retry_at = now(),
        last_retry_error = EXCLUDED.error_message
    `);
  } catch (logErr) {
    console.error(
      `[customer-quotes] recordCaptureFailure logging failed quote=${quoteId} reason=${reason}:`,
      logErr,
    );
  }
}

// Auto-resolve any open failure for (orgId, quoteId) the moment a freight
// opportunity is successfully created or refreshed. Keeps the admin queue
// clean without requiring a manual click.
export async function resolveOpenCaptureFailure(
  orgId: string,
  quoteId: string,
  freightOpportunityId: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE freight_opportunity_capture_failures
         SET resolved_at = now(),
             resolution_note = 'Auto-resolved: freight opportunity ' ||
                               ${freightOpportunityId} || ' created or refreshed'
       WHERE org_id = ${orgId}
         AND quote_id = ${quoteId}
         AND resolved_at IS NULL
    `);
  } catch (logErr) {
    console.error(
      `[customer-quotes] resolveOpenCaptureFailure failed quote=${quoteId}:`,
      logErr,
    );
  }
}

export async function createFreightOpportunityFromWonQuote(
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

    // Task #803 — Won Load Autopilot supersedes the previous 72h pickup
    // restriction: every won quote now generates a pending_approval freight
    // row regardless of pickup distance, because the NAM/AM popup is the
    // unified gate for "build this load and assign an LM." Past-pickup
    // quotes (e.g. a manually-late win) still build; we just clamp the
    // pickup window to today so the LM picks up the row immediately.

    // 3. Resolve company. freight_opportunities.companyId is NOT NULL, so a
    //    customer name with no matching CRM company can't be handed off.
    const [cust] = await db.select().from(quoteCustomers)
      .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.id, opp.customerId))).limit(1);
    const customerName = cust?.name ?? null;
    if (!customerName) {
      console.log(`[customer-quotes] AF handoff skipped (no customer) quote=${opp.id}`);
      await recordCaptureFailure(
        orgId,
        opp.id,
        "no_customer",
        "Quote has no customer mapping — cannot resolve a CRM company to attach the freight to.",
      );
      return null;
    }
    let companyId: string;
    const [matched] = await db.select({ id: companies.id }).from(companies)
      .where(and(eq(companies.organizationId, orgId), sql`LOWER(${companies.name}) = LOWER(${customerName})`))
      .limit(1);
    if (matched) {
      companyId = matched.id;
    } else {
      // Phase A2 — refuse to seed a fake/self-ref/greeting-fragment customer.
      // Once a fake company exists, every won quote on it spawns a freight opp
      // the LM has to triage even though no real party is attached. Match
      // against the org's brand name so the brokerage's own name can never be
      // resurrected as a customer here.
      const [orgRow] = await db.select({ name: organizations.name }).from(organizations)
        .where(eq(organizations.id, orgId)).limit(1);
      const fakeCheck = isObviousFakeCustomerName(customerName, orgRow?.name ?? null);
      if (fakeCheck.isFake) {
        console.log(
          `[customer-quotes] AF handoff blocked — obvious-fake customer name ` +
          `"${customerName}" reason=${fakeCheck.reason} quote=${opp.id}`,
        );
        await recordCaptureFailure(
          orgId,
          opp.id,
          "fake_customer",
          `Customer name "${customerName}" was rejected by the obvious-fake guard (${fakeCheck.reason}). Fix the underlying customer mapping or rename the company before retrying.`,
        );
        return null;
      }
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
        await recordCaptureFailure(
          orgId,
          opp.id,
          "company_create_failed",
          `Auto-create of CRM company "${customerName}" returned no row. Check companies table constraints, then retry.`,
        );
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
    // Task #803 — clamp pickup to today if requestDate is in the past so the
    // LM picks up the row immediately rather than seeing a stale window.
    const todayIso = new Date().toISOString().slice(0, 10);
    const reqDateIso = opp.requestDate.toISOString().slice(0, 10);
    const pickupDay = reqDateIso < todayIso ? todayIso : reqDateIso;
    const sourceRef = {
      type: "won_quote" as const,
      quoteId: opp.id,
      buy: opp.carrierPaid,   // null until the rep records carrier cost
      sell: opp.quotedAmount, // the customer-facing rate locked in at win
    };
    // Task #803 — pre-fill the carrier-facing target buy at 85% of the sell
    // price as a safe starting ceiling. The LM can edit it before sending.
    const quotedRateStr = opp.quotedAmount;
    let targetBuyRateStr: string | null = null;
    if (quotedRateStr) {
      const n = Number(quotedRateStr);
      if (isFinite(n) && n > 0) targetBuyRateStr = (n * 0.85).toFixed(2);
    }

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
        // Task #803 — refresh known fields from the latest quote snapshot but
        // do NOT reset status/approval state on an idempotent re-save.
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
          sourceQuoteId: opp.id,
          quotedRate: quotedRateStr,
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
        sourceQuoteId: opp.id,
        quotedRate: quotedRateStr,
        targetBuyRate: targetBuyRateStr,
        urgencyScore: 70,
        // Task #803 — Won Load Autopilot: every won quote starts in
        // pending_approval and waits for the NAM/AM popup to assign an LM.
        status: "pending_approval",
        awaitingApprovalSince: new Date(),
        createdById: actorUserId,
        ownerUserId,
        notes: opp.notes,
      };
      const [createdRow] = await tx.insert(freightOpportunities).values(insert)
        .returning({ id: freightOpportunities.id });
      console.log(`[customer-quotes] AF handoff created opp=${createdRow?.id} quote=${opp.id} pickup=${pickupDay} status=pending_approval`);
      if (createdRow) {
        return { id: createdRow.id, created: true };
      }
      return null;
    }).then(async (result) => {
      // Phase A5 — the transaction can technically resolve without a created
      // row (driver returned no row); make that final null path observable
      // instead of silently dropping the won quote.
      if (!result) {
        await recordCaptureFailure(
          orgId,
          opp.id,
          "exception",
          "Freight insert returned no row from the database driver. Retry to re-run the converter; if it persists, capture the server logs for the matching quote id.",
        );
        return result;
      }
      // Task #803 — fire the autopilot notification AFTER commit so the popup
      // never beats the row into the DB. Best-effort: a notification failure
      // must not retract the freight row.
      if (result?.created && ownerUserId) {
        try {
          await storage.createNotification({
            userId: ownerUserId,
            type: "won_load_pending_approval",
            title: "Won load needs an LM",
            body: `${opp.originCity} → ${opp.destCity} (${equipment ?? "load"}) just won. Assign a Logistics Manager to start carrier outreach.`,
            link: `/my-procurement?wonLoad=${result.id}`,
            relatedId: result.id,
          });
        } catch (err) {
          console.error(`[customer-quotes] won-load notification failed opp=${result.id}:`, err);
        }
      }
      // Phase A5 — auto-resolve any open capture-failure for this quote the
      // moment a freight opp is created OR refreshed. Covers the manual-retry
      // path (admin clicks Retry → converter succeeds → admin queue clears).
      if (result?.id) {
        await resolveOpenCaptureFailure(orgId, opp.id, result.id);
      }
      return result;
    });
  } catch (err) {
    console.error(`[customer-quotes] AF handoff failed quote=${opp.id}:`, err);
    await recordCaptureFailure(
      orgId,
      opp.id,
      "exception",
      "Converter threw an uncaught exception. See errorMessage / errorStack for details, fix the underlying issue, then retry.",
      err,
    );
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

  // Task #968 — Convert-to-quote handoff from the Conversations detail
  // pane. When the rep passes `sourceThreadId` (and didn't explicitly set
  // source/sourceReference), find the most recent inbound message on
  // that thread inside this org and stamp it as the quote's source. This
  // makes the new opp show up in `attachSourceThreads` with a working
  // "Open in Conversations" deep-link, matching the email-ingested
  // contract instead of leaving the source cell blank for a rep-initiated
  // conversion. Outbound-only threads (rep started the convo) fall back
  // to the latest message of any direction so the link still works.
  let resolvedSource = input.source ?? null;
  let resolvedSourceRef = input.sourceReference ?? null;
  if (input.sourceThreadId && !resolvedSourceRef) {
    const matches = await db.execute<{ id: string; direction: string }>(sql`
      SELECT id, direction
        FROM email_messages
       WHERE org_id = ${orgId}
         AND thread_id = ${input.sourceThreadId}
       ORDER BY direction = 'inbound' DESC, COALESCE(provider_sent_at, created_at) DESC
       LIMIT 1
    `);
    const msg = matches.rows[0];
    if (!msg) {
      throw new Error("Cannot convert thread to quote — no captured messages on this thread yet");
    }
    resolvedSourceRef = msg.id;
    resolvedSource = resolvedSource ?? "email";
  }

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
    source: resolvedSource ?? "manual",
    sourceReference: resolvedSourceRef,
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
  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);
  const filtered = applyFilters(all, filters, nonCustomerIds, ctx.customerFacingRepIds);
  // Customer Quotes portlet bug-fix — same Tier-1 rep + canonical-name
  // wiring as listQuotes so the CSV export matches what users see in the
  // table. Skipping this would let the export silently regress to
  // "Unassigned" / sluggified strings.
  const repByOpportunityId = await resolveRepsFromSourceEmails(orgId, filtered);
  const enriched = enrich(filtered, ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, {
    funnelEligibleRepIds: ctx.customerFacingRepIds,
    repDisplayNames: ctx.repDisplayNames,
    repByOpportunityId,
    canonicalCustomerNames: ctx.canonicalCustomerNames,
    ownerRepNameByCustomerId: ctx.ownerRepNameByCustomerId,
  });
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

  // Customer Quotes portlet bug-fix — pass the canonical name + display
  // name maps so spot-search result rows show the same customer/rep names
  // as the main portlet table. Tier-1 source-email rep is intentionally
  // skipped here (these are historical context rows, not the live work
  // queue, and we don't want to pay the extra query per spot search).
  const enrichOpts = {
    funnelEligibleRepIds: ctx.customerFacingRepIds,
    repDisplayNames: ctx.repDisplayNames,
    canonicalCustomerNames: ctx.canonicalCustomerNames,
    ownerRepNameByCustomerId: ctx.ownerRepNameByCustomerId,
  };
  const exactMatches = enrich(exactScoped.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, enrichOpts);
  const similarMatches = enrich(similarScoped.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, enrichOpts);

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
      const items = enrich(list.slice(0, 25), ctx.customerMap, ctx.repMap, ctx.carrierMap, ctx.reasonMap, enrichOpts);
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
  // Task #723 — true when the bucket has no decided outcomes yet and we
  // fell back to ranking by total volume. The client renders a different
  // subtitle ("Decided outcomes pending — showing volume") so reps know the
  // table is showing activity, not win-rate.
  volumeFallback: boolean;
};

export type FunnelPerformers = {
  lanes: FunnelPerformerSplit;
  customers: FunnelPerformerSplit;
  reps: FunnelPerformerSplit;
};

// Task #723 — when the slice has no decided losses, the "Why we lose"
// portlet still has useful signal: how many quotes exited as stale, expired
// or no-response. Always returned (cheap to compute) so the client can
// render the fallback purely client-side without a second round trip.
export type FunnelQuietBreakdown = {
  stale: number;
  expired: number;
  noResponse: number;
  total: number;
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
  // Task #723 — exit-type breakdown used by the "Why they go quiet" fallback
  // when the slice has no decided losses but does have stale/expired exits.
  quietBreakdown: FunnelQuietBreakdown;
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
      lanes: { best: [], worst: [], volumeFallback: false },
      customers: { best: [], worst: [], volumeFallback: false },
      reps: { best: [], worst: [], volumeFallback: false },
    },
    quietBreakdown: { stale: 0, expired: 0, noResponse: 0, total: 0 },
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

  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);
  // Compose viewer scoping with caller filters. We OR the rep filter onto
  // the existing filters so an admin can still drill into a rep view via
  // the UI filter bar, while a scoped rep cannot see anyone else.
  const effectiveFilters: QuoteFilters = scopedRepId
    ? { ...filters, repId: scopedRepId }
    : filters;
  const filtered = applyFilters(allOpps, effectiveFilters, nonCustomerIds, ctx.customerFacingRepIds);

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
  // Task #723 — split out the three "quiet exit" buckets so the loss-reasons
  // portlet can fall back to a "Why they go quiet" view when no decided
  // losses exist. `staleByAge` only counts pending rows aged past threshold
  // (the no_response / expired statuses are tracked separately so we don't
  // double-count when a quote is BOTH old AND already flipped).
  let staleByAge = 0;
  let noResponseExit = 0;
  let expiredExit = 0;
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
    if (isStaleByAge) staleByAge++;
    if (r.outcomeStatus === "no_response") noResponseExit++;
    if (r.outcomeStatus === "expired") expiredExit++;
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
  //
  // Task #723 — when no rows in this bucket have any decisions yet, fall
  // back to a volume-ranked list (most active first, with a placeholder for
  // "Worst" so the table layout stays balanced). The flag tells the client
  // to swap the column header / subtitle.
  function splitBestWorst(
    rows: FunnelPerformerRow[],
    n: number,
  ): FunnelPerformerSplit {
    const decided = rows.filter(r => r.won + r.lost > 0);
    if (decided.length === 0) {
      // Volume fallback: rank everyone by total quote count, descending.
      // We split the top N into halves so the existing two-column UI still
      // renders something useful — left = "Most active", right = "Least
      // active among the top tier" (the rows are still ranked by total so
      // the right column is the back end of the same list).
      const ranked = rows.slice().sort((a, b) => b.total - a.total);
      return {
        best: ranked.slice(0, n),
        worst: [],
        volumeFallback: true,
      };
    }
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
    return { best, worst, volumeFallback: false };
  }

  const PERFORMER_TOP_N = 5;
  const performers: FunnelPerformers = {
    lanes: splitBestWorst(toRows(laneAgg, 1), PERFORMER_TOP_N),
    customers: splitBestWorst(toRows(customerAgg, 1), PERFORMER_TOP_N),
    reps: splitBestWorst(toRows(repAgg, 1), PERFORMER_TOP_N),
  };

  const quietBreakdown: FunnelQuietBreakdown = {
    stale: staleByAge,
    expired: expiredExit,
    noResponse: noResponseExit,
    total: staleByAge + expiredExit + noResponseExit,
  };

  return {
    stages,
    summary,
    lossReasons,
    performers,
    quietBreakdown,
    scopedToRepId: scopedRepId ?? null,
  };
}

// ─── Task #723: Funnel diagnostics (admin-only Capture funnel diagnostics) ──
//
// Combines (a) the per-org TMS sync stats kept in-memory by quoteTmsSync,
// (b) a count of inbound emails that landed Won/Lost/neither over the recent
// window, and (c) the top "near-miss" TMS candidates (probable matches the
// new looser matcher found but didn't auto-flip). Scoped to the same filter
// shape the funnel uses so an admin filtering "this rep, last 30 days" sees
// matching diagnostics.

export interface EmailClassifierCounts {
  windowDays: number;
  won: number;
  lost: number;
  neither: number;
}

/** Task #753 — surfaces the size of the "needs review" backlog so admins
 *  can spot leak regressions before the cleanup script catches them. */
export interface NeedsReviewCounts {
  /** Customer rows in the org currently named `UNKNOWN_CUSTOMER_NAME` OR
   *  matching a free-mail provider name (Gmail / yahoo.com / Outlook …). */
  customers: number;
  /** Quote opportunities in the current filter slice linked to one of
   *  those rows. The slice ignores the customer-only chokepoint so the
   *  unknown-bucket opps are visible here even though they're hidden from
   *  the main funnel. */
  opportunities: number;
}

export interface FunnelDiagnostics {
  scopedToRepId: string | null;
  lastSync: import("./quoteTmsSync").SyncStats | null;
  emailClassifier: EmailClassifierCounts;
  /** Subset of the latest sync's probable candidates that pass the current
   *  filter slice (rep / customer / equipment / lane / dates). */
  nearMissCandidates: import("./quoteTmsSync").ProbableCandidate[];
  needsReview: NeedsReviewCounts;
  /** Task #803 — pending Quote Lifecycle Autopilot prompts: opps where
   *  the inbound sender's domain matched a known customer but their
   *  email is not yet in our CRM contacts. Cleared when the rep clicks
   *  Add-as-contact or Dismiss in the Quote Opportunities table. */
  newSendersToReview: number;
  /** Inbound customer emails the org processed in the recent
   *  `emailClassifier.windowDays` window that produced no quote-intent
   *  signal AND did not lead to a quote opportunity — the "we saw it but
   *  didn't interpret it as quote-related" leak counter. Computed from
   *  email_messages × email_signals × quote_opportunities; never null. */
  missingIntentInboundCount: number;
  /** Outbound emails the org sent in the recent
   *  `emailClassifier.windowDays` window that landed on an email thread
   *  with no pending quote opportunity — the autopilot's "extracted a
   *  rate but had nowhere to attach it" approximation. Conservative
   *  counter: includes outbound emails on threads we never quoted from,
   *  not just rate-bearing replies (the AI extractor doesn't run on the
   *  no-pending path so we cannot cheaply distinguish the two without a
   *  behaviour change). Never null. */
  orphanOutboundCount: number;
  /** True when `OUTLOOK_WEBHOOK_SECRET` is configured. Surfaces the
   *  webhook validation gate to admins without exposing the value
   *  itself. When false, real-time Graph notifications are refused at
   *  the webhook handler — see `server/routes/graphWebhook.ts`. */
  hasWebhookSecret: boolean;
}

export async function getFunnelDiagnostics(
  orgId: string,
  filters: QuoteFilters,
  scopedRepId: string | null | "__none__",
  opts: { emailWindowDays?: number } = {},
): Promise<FunnelDiagnostics> {
  const { getLastSyncStats } = await import("./quoteTmsSync");
  const windowDays = opts.emailWindowDays ?? 14;

  if (scopedRepId === "__none__") {
    return {
      scopedToRepId: null,
      lastSync: null,
      emailClassifier: { windowDays, won: 0, lost: 0, neither: 0 },
      nearMissCandidates: [],
      needsReview: { customers: 0, opportunities: 0 },
      newSendersToReview: 0,
      missingIntentInboundCount: 0,
      orphanOutboundCount: 0,
      hasWebhookSecret: Boolean(process.env.OUTLOOK_WEBHOOK_SECRET?.trim()),
    };
  }

  // Filter the cached probable-match candidates against the same filter
  // slice the funnel uses. Need the org's quote rows + customer map to do
  // the matching; if the cache is empty we still return a useful shell.
  const lastSync = getLastSyncStats(orgId);
  const ctx = await loadContext(orgId);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(eq(quoteOpportunities.organizationId, orgId));

  const nonCustomerIds = await loadNonCustomerCustomerIds(orgId, ctx.customerMap);
  const effectiveFilters: QuoteFilters = scopedRepId
    ? { ...filters, repId: scopedRepId }
    : filters;
  const filtered = applyFilters(allOpps, effectiveFilters, nonCustomerIds);
  const filteredIdSet = new Set(filtered.map(o => o.id));
  const filteredIds = Array.from(filteredIdSet);

  const nearMissCandidates = (lastSync?.probableCandidates ?? [])
    .filter(c => filteredIdSet.has(c.quoteId))
    .slice(0, 20);

  // Email classifier counts: count quote_events of type email_won /
  // email_lost in the recent window for the filtered slice. Anything inbound
  // on a quote thread that produced NEITHER is "neither". We approximate
  // "neither" by counting inbound email_messages on threads associated with
  // these quotes (via sourceReference) minus the won+lost count. That's a
  // bounded-cost query: we restrict to quotes in the filtered slice, not
  // every quote in the org.
  let emailWon = 0;
  let emailLost = 0;
  let emailTotalInbound = 0;
  if (filteredIds.length > 0) {
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
    const events = await db.select({
      eventType: quoteEvents.eventType,
    }).from(quoteEvents).where(and(
      inArray(quoteEvents.quoteId, filteredIds),
      sql`${quoteEvents.occurredAt} >= ${since}`,
    ));
    for (const e of events) {
      if (e.eventType === "email_won") emailWon++;
      else if (e.eventType === "email_lost") emailLost++;
    }

    // Approximate "neither" — inbound email replies on the quote threads
    // that did NOT trigger a won/lost event. For each filtered quote with a
    // sourceReference, look up the email_messages on the same thread.
    const refs = Array.from(new Set(
      filtered
        .map(o => o.sourceReference)
        .filter((v): v is string => !!v),
    ));
    if (refs.length > 0) {
      const seedMsgs = await db.select({
        threadId: emailMessages.threadId,
      }).from(emailMessages).where(and(
        eq(emailMessages.orgId, orgId),
        inArray(emailMessages.providerMessageId, refs),
      ));
      const threadIds = Array.from(new Set(
        seedMsgs.map(m => m.threadId).filter((v): v is string => !!v),
      ));
      if (threadIds.length > 0) {
        const inbound = await db.select({ id: emailMessages.id })
          .from(emailMessages).where(and(
            eq(emailMessages.orgId, orgId),
            eq(emailMessages.direction, "inbound"),
            inArray(emailMessages.threadId, threadIds),
            sql`${emailMessages.providerSentAt} >= ${since}`,
          ));
        emailTotalInbound = inbound.length;
      }
    }
  }

  const neither = Math.max(0, emailTotalInbound - emailWon - emailLost);

  // Task #753 — needs-review counter. Counts customer rows (org-wide) and
  // opportunities (in the slice, BUT bypassing the customer-only chokepoint
  // since the unknown-bucket rows are non-customer by definition) that
  // currently sit in the shared `UNKNOWN_CUSTOMER_NAME` bucket OR carry a
  // free-mail provider name. Provider-named rows would normally have been
  // sanitized away at insert time; if any show up here it's a regression
  // signal worth surfacing to admins.
  const needsReviewCustomerIds = new Set<string>();
  ctx.customerMap.forEach((c, id) => {
    const n = (c.name ?? "").trim();
    if (!n) { needsReviewCustomerIds.add(id); return; }
    if (n.toLowerCase() === UNKNOWN_CUSTOMER_NAME.toLowerCase()) {
      needsReviewCustomerIds.add(id);
      return;
    }
    if (isFreeMailProviderName(n)) needsReviewCustomerIds.add(id);
  });
  // Re-run the slice filter WITHOUT the non-customer chokepoint so the
  // unknown-bucket opportunities are visible here. Without this, the
  // opportunities count would always be 0 because `applyFilters` already
  // excludes them above.
  const sliceWithoutChokepoint = applyFilters(allOpps, effectiveFilters);
  const needsReviewOppCount = needsReviewCustomerIds.size === 0
    ? 0
    : sliceWithoutChokepoint.filter(o => o.customerId && needsReviewCustomerIds.has(o.customerId)).length;

  // Task #803 — count opps in the slice with a pending new-contact prompt.
  const newSendersInSlice = sliceWithoutChokepoint.filter(
    (o) => o.needsNewContactReview != null,
  ).length;

  // ─── Leak counters (additive metrics, no behavior change) ────────────────
  // Both counters share the same `windowDays` window the email classifier
  // counts use above so dashboards can correlate the four values
  // (won/lost/neither/missing-intent) on the same axis.
  //
  // The actual candidate-id resolution lives in `buildLeakCandidateIds`
  // so `getLeakedQuoteEmails` (the row-level queue endpoint) computes
  // the same set the counts derive from. Counts here are .length of the
  // returned arrays — they cannot drift from the queue.
  const leakCandidates = await buildLeakCandidateIds(orgId, windowDays);
  const missingIntentInboundCount = leakCandidates.missedInboundIds.length;
  const orphanOutboundCount = leakCandidates.orphanOutboundIds.length;

  // Webhook secret presence — flagged at the diagnostics layer so admins
  // can confirm the webhook validation gate is configured without us
  // exposing the secret value itself.
  const hasWebhookSecret = Boolean(process.env.OUTLOOK_WEBHOOK_SECRET?.trim());

  return {
    scopedToRepId: scopedRepId ?? null,
    lastSync: lastSync ?? null,
    emailClassifier: {
      windowDays,
      won: emailWon,
      lost: emailLost,
      neither,
    },
    nearMissCandidates,
    needsReview: {
      customers: needsReviewCustomerIds.size,
      opportunities: needsReviewOppCount,
    },
    newSendersToReview: newSendersInSlice,
    missingIntentInboundCount,
    orphanOutboundCount,
    hasWebhookSecret,
  };
}

// ─── Capture leak queue (Phase 1, read-only) ─────────────────────────────
// Row-level expansion of the two leak counters surfaced by
// `getFunnelDiagnostics`. Both functions share `buildLeakCandidateIds` so
// the count and the list cannot drift.
//
// Phase 1 is intentionally minimal: read-only, Open thread is the only
// row action, no dismissals, no auto-create. See the diagnostics panel
// in client/src/components/customer-quotes/FreightCaptureDiagnostics.tsx
// for the consumer.

const QUOTE_INTENT_TYPES_FOR_LEAK = [
  "pricing_request",
  "new_opportunity",
  "closed_won_indicator",
  "closed_lost_indicator",
];

interface LeakCandidateIds {
  windowDays: number;
  leakSince: Date;
  /** Inbound message ids that meet the missed-intent criteria, sorted
   *  by providerSentAt DESC for direct slicing into a paginated queue. */
  missedInboundIds: string[];
  /** Outbound message ids that meet the orphan criteria, sorted by
   *  providerSentAt DESC. */
  orphanOutboundIds: string[];
}

/**
 * Resolve the candidate id sets for both leak categories. Pure data-
 * shaping function — no business logic, no side effects, no auth. The
 * caller is responsible for org/role gating.
 */
async function buildLeakCandidateIds(
  orgId: string,
  windowDays: number,
): Promise<LeakCandidateIds> {
  const raw = await buildRawLeakCandidates(orgId, windowDays);
  const missedInboundIds = raw.missedInbound.map(r => r.id);
  const orphanOutboundIds = raw.orphanOutbound.map(r => r.id);

  // Phase 2A — exclude any (messageId, leakType) the admin has already
  // reviewed (decision = "not_quote" or "ignored"). Filtering at this
  // single chokepoint preserves the no-drift guarantee between
  // `getFunnelDiagnostics`'s counters and `getLeakedQuoteEmails`'s rows.
  const allCandidateIds = [...missedInboundIds, ...orphanOutboundIds];
  if (allCandidateIds.length > 0) {
    const reviewed = await db
      .select({
        messageId: captureLeakReviews.messageId,
        leakType: captureLeakReviews.leakType,
      })
      .from(captureLeakReviews)
      .where(and(
        eq(captureLeakReviews.organizationId, orgId),
        inArray(captureLeakReviews.messageId, allCandidateIds),
      ));
    if (reviewed.length > 0) {
      const reviewedInbound = new Set<string>();
      const reviewedOutbound = new Set<string>();
      for (const r of reviewed) {
        if (r.leakType === "missed_inbound") reviewedInbound.add(r.messageId);
        else if (r.leakType === "orphan_outbound") reviewedOutbound.add(r.messageId);
      }
      const filteredMissed = reviewedInbound.size > 0
        ? missedInboundIds.filter(id => !reviewedInbound.has(id))
        : missedInboundIds;
      const filteredOrphan = reviewedOutbound.size > 0
        ? orphanOutboundIds.filter(id => !reviewedOutbound.has(id))
        : orphanOutboundIds;
      return {
        windowDays,
        leakSince: raw.leakSince,
        missedInboundIds: filteredMissed,
        orphanOutboundIds: filteredOrphan,
      };
    }
  }

  return {
    windowDays,
    leakSince: raw.leakSince,
    missedInboundIds,
    orphanOutboundIds,
  };
}

/**
 * Phase 3 — extracted underlying candidate query (pre-review-filter).
 * Returns the raw missed-inbound / orphan-outbound rows along with their
 * provider sent timestamps so analytics callers can bucket by date or
 * compute aging without a second emailMessages round-trip. The review
 * filter lives in `buildLeakCandidateIds` so the queue + counters stay
 * in lock-step; the trendline in `getLeakAnalytics` reads this raw view
 * directly because it needs to count rows discovered on day X regardless
 * of whether they were later resolved.
 */
interface RawLeakCandidate {
  id: string;
  providerSentAt: Date;
}
interface RawOrphanCandidate extends RawLeakCandidate {
  threadId: string | null;
}
interface RawLeakCandidates {
  windowDays: number;
  leakSince: Date;
  missedInbound: RawLeakCandidate[];
  orphanOutbound: RawOrphanCandidate[];
}
async function buildRawLeakCandidates(
  orgId: string,
  windowDays: number,
): Promise<RawLeakCandidates> {
  const leakSince = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  // ── Missed inbound ─────────────────────────────────────────────────────
  const inboundCandidates = await db
    .select({
      id: emailMessages.id,
      providerMessageId: emailMessages.providerMessageId,
      providerSentAt: emailMessages.providerSentAt,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.direction, "inbound"),
      sql`${emailMessages.processedForSignalsAt} IS NOT NULL`,
      sql`${emailMessages.providerSentAt} >= ${leakSince}`,
    ))
    .orderBy(desc(emailMessages.providerSentAt));

  const missedInbound: RawLeakCandidate[] = [];
  if (inboundCandidates.length > 0) {
    const candidateIds = inboundCandidates.map(m => m.id);
    const candidateProviderIds = inboundCandidates
      .map(m => m.providerMessageId)
      .filter((v): v is string => !!v);

    const hasQuoteIntentRows = await db
      .selectDistinct({ messageId: emailSignals.messageId })
      .from(emailSignals)
      .where(and(
        inArray(emailSignals.messageId, candidateIds),
        inArray(emailSignals.intentType, QUOTE_INTENT_TYPES_FOR_LEAK),
      ));
    const messagesWithQuoteIntent = new Set(hasQuoteIntentRows.map(r => r.messageId));

    const refUniverse = Array.from(new Set([...candidateIds, ...candidateProviderIds]));
    const referencedRows = refUniverse.length > 0
      ? await db
          .selectDistinct({ ref: quoteOpportunities.sourceReference })
          .from(quoteOpportunities)
          .where(and(
            eq(quoteOpportunities.organizationId, orgId),
            eq(quoteOpportunities.source, "email"),
            inArray(quoteOpportunities.sourceReference, refUniverse),
          ))
      : [];
    const referencedSet = new Set(referencedRows.map(r => r.ref).filter((v): v is string => !!v));

    for (const m of inboundCandidates) {
      if (messagesWithQuoteIntent.has(m.id)) continue;
      if (referencedSet.has(m.id)) continue;
      if (m.providerMessageId && referencedSet.has(m.providerMessageId)) continue;
      missedInbound.push({ id: m.id, providerSentAt: m.providerSentAt ?? new Date(0) });
    }
  }

  // ── Orphan outbound ────────────────────────────────────────────────────
  const outboundCandidates = await db
    .select({
      id: emailMessages.id,
      threadId: emailMessages.threadId,
      providerSentAt: emailMessages.providerSentAt,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.direction, "outbound"),
      sql`${emailMessages.threadId} IS NOT NULL`,
      sql`${emailMessages.providerSentAt} >= ${leakSince}`,
    ))
    .orderBy(desc(emailMessages.providerSentAt));

  const orphanOutbound: RawOrphanCandidate[] = [];
  if (outboundCandidates.length > 0) {
    const pendingThreadRows = await db
      .selectDistinct({ threadId: emailMessages.threadId })
      .from(quoteOpportunities)
      .innerJoin(
        emailMessages,
        and(
          eq(emailMessages.orgId, orgId),
          sql`(${emailMessages.id} = ${quoteOpportunities.sourceReference}
               OR ${emailMessages.providerMessageId} = ${quoteOpportunities.sourceReference})`,
        ),
      )
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        eq(quoteOpportunities.source, "email"),
        eq(quoteOpportunities.outcomeStatus, "pending"),
      ));
    const threadsWithPendingQuote = new Set(
      pendingThreadRows.map(r => r.threadId).filter((v): v is string => !!v),
    );
    for (const m of outboundCandidates) {
      if (m.threadId && threadsWithPendingQuote.has(m.threadId)) continue;
      orphanOutbound.push({
        id: m.id,
        providerSentAt: m.providerSentAt ?? new Date(0),
        threadId: m.threadId,
      });
    }
  }

  return { windowDays, leakSince, missedInbound, orphanOutbound };
}

/** Per-row classification of whether the message has a useful customer
 *  link — Phase 1 cue so the rep can triage at a glance. */
export type LeakCustomerState =
  | "known_customer"     // linkedAccountId + real-looking name
  | "unknown_customer"   // linkedAccountId set but the company is in the
                         // shared "Unknown" / free-mail bucket
  | "no_linked_customer";// no linkedAccountId at all

export interface LeakedInboundRow {
  messageId: string;
  threadId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  bodySnippet: string | null;
  receivedAt: string;
  linkedCustomerId: string | null;
  linkedCustomerName: string | null;
  customerState: LeakCustomerState;
}

export interface LeakedOutboundRow {
  messageId: string;
  threadId: string;
  toEmail: string | null;
  subject: string | null;
  bodySnippet: string | null;
  sentAt: string;
  linkedCustomerId: string | null;
  linkedCustomerName: string | null;
  customerState: LeakCustomerState;
  /** Best-effort context: most recent inbound message on the same thread
   *  (if any) so the rep can tell at a glance whether the thread looked
   *  quote-shaped before we replied. Phase 1 leaves this read-only. */
  lastInboundFromEmail: string | null;
  lastInboundSubject: string | null;
  lastInboundAt: string | null;
}

export interface LeakedQueueResult {
  type: "missed_inbound" | "orphan_outbound";
  windowDays: number;
  /** Total candidate rows for this slice + window, for paging math. */
  total: number;
  hasMore: boolean;
  rows: LeakedInboundRow[] | LeakedOutboundRow[];
}

export interface GetLeakedQuoteEmailsOpts {
  type: "missed_inbound" | "orphan_outbound";
  windowDays?: number;
  limit?: number;
  offset?: number;
}

const LEAK_LIMIT_DEFAULT = 50;
const LEAK_LIMIT_MAX = 100;
const LEAK_OFFSET_MAX = 1000;
const LEAK_BODY_SNIPPET_LEN = 200;

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function trimSnippet(body: string | null): string | null {
  if (!body) return null;
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > LEAK_BODY_SNIPPET_LEN
    ? collapsed.slice(0, LEAK_BODY_SNIPPET_LEN) + "…"
    : collapsed;
}

/** Parse a "Display Name <addr@host>" header into its two pieces. We
 *  store the raw value in `from_email`, so this is best-effort and never
 *  throws — falls back to the raw string. */
function parseFromHeader(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const trimmed = raw.trim();
  const m = trimmed.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const name = (m[1] ?? "").trim();
    return { name: name.length > 0 ? name : null, email: m[2].trim() || null };
  }
  // No display name; raw is just the address.
  return { name: null, email: trimmed };
}

function classifyCustomerState(
  linkedAccountId: string | null,
  customerName: string | null,
): LeakCustomerState {
  if (!linkedAccountId) return "no_linked_customer";
  const n = (customerName ?? "").trim();
  if (!n) return "unknown_customer";
  if (n.toLowerCase() === UNKNOWN_CUSTOMER_NAME.toLowerCase()) return "unknown_customer";
  if (isFreeMailProviderName(n)) return "unknown_customer";
  return "known_customer";
}

/**
 * Page through the leak rows behind `getFunnelDiagnostics`'s counters.
 * Read-only. Returns `{ total, hasMore, rows }` so the UI can show
 * "Showing 1–50 of N" without a separate count call.
 */
export async function getLeakedQuoteEmails(
  orgId: string,
  scopedRepId: string | null | "__none__",
  opts: GetLeakedQuoteEmailsOpts,
): Promise<LeakedQueueResult> {
  const type = opts.type;
  const windowDays = opts.windowDays ?? 14;
  const limit = clamp(opts.limit ?? LEAK_LIMIT_DEFAULT, 1, LEAK_LIMIT_MAX);
  const offset = clamp(opts.offset ?? 0, 0, LEAK_OFFSET_MAX);

  // Same short-circuit getFunnelDiagnostics uses: if the caller can see
  // no funnel data at all (rep with no quote access), they see no leaks.
  if (scopedRepId === "__none__") {
    return { type, windowDays, total: 0, hasMore: false, rows: [] };
  }

  const candidates = await buildLeakCandidateIds(orgId, windowDays);
  const idPool = type === "missed_inbound"
    ? candidates.missedInboundIds
    : candidates.orphanOutboundIds;
  const total = idPool.length;
  const pageIds = idPool.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  if (pageIds.length === 0) {
    return { type, windowDays, total, hasMore: false, rows: [] };
  }

  // Pull the full message rows for the page (only the page — never the
  // whole id pool) and resolve the linked-account name in one batch.
  const messages = await db
    .select({
      id: emailMessages.id,
      threadId: emailMessages.threadId,
      fromEmail: emailMessages.fromEmail,
      toEmail: emailMessages.toEmail,
      subject: emailMessages.subject,
      body: emailMessages.body,
      providerSentAt: emailMessages.providerSentAt,
      linkedAccountId: emailMessages.linkedAccountId,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      inArray(emailMessages.id, pageIds),
    ));

  const accountIds = Array.from(new Set(
    messages.map(m => m.linkedAccountId).filter((v): v is string => !!v),
  ));
  const accountNameById = new Map<string, string>();
  if (accountIds.length > 0) {
    const rows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, accountIds));
    for (const r of rows) accountNameById.set(r.id, r.name);
  }

  // Preserve the providerSentAt-DESC order from `idPool` — `inArray`
  // doesn't guarantee row order. Build a position map and sort.
  const positionById = new Map<string, number>();
  pageIds.forEach((id, i) => positionById.set(id, i));
  const ordered = [...messages].sort((a, b) => {
    const ai = positionById.get(a.id) ?? 0;
    const bi = positionById.get(b.id) ?? 0;
    return ai - bi;
  });

  if (type === "missed_inbound") {
    const rows: LeakedInboundRow[] = ordered.map(m => {
      const parsed = parseFromHeader(m.fromEmail);
      const customerName = m.linkedAccountId
        ? accountNameById.get(m.linkedAccountId) ?? null
        : null;
      return {
        messageId: m.id,
        threadId: m.threadId,
        fromEmail: parsed.email,
        fromName: parsed.name,
        subject: m.subject,
        bodySnippet: trimSnippet(m.body),
        receivedAt: (m.providerSentAt ?? new Date(0)).toISOString(),
        linkedCustomerId: m.linkedAccountId,
        linkedCustomerName: customerName,
        customerState: classifyCustomerState(m.linkedAccountId, customerName),
      };
    });
    return { type, windowDays, total, hasMore, rows };
  }

  // orphan_outbound — additionally fetch one "most recent inbound on
  // this thread" per row, in a single bounded query.
  const threadIds = Array.from(new Set(
    ordered.map(m => m.threadId).filter((v): v is string => !!v),
  ));
  const lastInboundByThread = new Map<string, {
    fromEmail: string | null;
    subject: string | null;
    sentAt: Date | null;
  }>();
  if (threadIds.length > 0) {
    const inboundRows = await db
      .select({
        threadId: emailMessages.threadId,
        fromEmail: emailMessages.fromEmail,
        subject: emailMessages.subject,
        providerSentAt: emailMessages.providerSentAt,
      })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        eq(emailMessages.direction, "inbound"),
        inArray(emailMessages.threadId, threadIds),
      ))
      .orderBy(desc(emailMessages.providerSentAt));
    for (const r of inboundRows) {
      if (!r.threadId) continue;
      if (lastInboundByThread.has(r.threadId)) continue; // first row wins (DESC sort)
      const parsed = parseFromHeader(r.fromEmail);
      lastInboundByThread.set(r.threadId, {
        fromEmail: parsed.email,
        subject: r.subject,
        sentAt: r.providerSentAt,
      });
    }
  }

  const rows: LeakedOutboundRow[] = ordered.map(m => {
    const customerName = m.linkedAccountId
      ? accountNameById.get(m.linkedAccountId) ?? null
      : null;
    const lastInbound = m.threadId ? lastInboundByThread.get(m.threadId) : undefined;
    return {
      messageId: m.id,
      threadId: m.threadId ?? "", // candidate-id query already required NOT NULL
      toEmail: m.toEmail,
      subject: m.subject,
      bodySnippet: trimSnippet(m.body),
      sentAt: (m.providerSentAt ?? new Date(0)).toISOString(),
      linkedCustomerId: m.linkedAccountId,
      linkedCustomerName: customerName,
      customerState: classifyCustomerState(m.linkedAccountId, customerName),
      lastInboundFromEmail: lastInbound?.fromEmail ?? null,
      lastInboundSubject: lastInbound?.subject ?? null,
      lastInboundAt: lastInbound?.sentAt?.toISOString() ?? null,
    };
  });
  return { type, windowDays, total, hasMore, rows };
}

// ─── Phase 3 — Capture leak analytics ────────────────────────────────────

export interface LeakResolutionMix {
  notQuote: number;
  ignored: number;
  createdQuote: number;
  /** Phase 4 — orphan_outbound rows manually attached to an existing
   *  quote_opportunity. Sourced from `capture_leak_reviews.decision='attached'`. */
  attached: number;
  total: number;
}

export interface LeakAgingBuckets {
  lt1d: number;
  d1to3: number;
  d3to7: number;
  d7to14: number;
  gt14: number;
  total: number;
  /** Oldest sentAt across this slice (ISO) — drives the headline "oldest
   *  unresolved age" tile. `null` when the slice is empty. */
  oldestSentAt: string | null;
}

export interface LeakTrendPoint {
  /** ISO date (YYYY-MM-DD) in UTC. */
  date: string;
  discovered: number;
  resolved: number;
}

export interface LeakAnalyticsResult {
  /** Window used for the aging slice (mirrors the queue default). */
  agingWindowDays: number;
  /** Window used for the trendline + 30-day resolution mix. */
  trendWindowDays: number;
  generatedAt: string;
  resolutionMix: { sevenDay: LeakResolutionMix; thirtyDay: LeakResolutionMix };
  aging: { missedInbound: LeakAgingBuckets; orphanOutbound: LeakAgingBuckets };
  trend: LeakTrendPoint[];
}

const EMPTY_MIX: LeakResolutionMix = { notQuote: 0, ignored: 0, createdQuote: 0, attached: 0, total: 0 };
const EMPTY_BUCKETS: LeakAgingBuckets = {
  lt1d: 0, d1to3: 0, d3to7: 0, d7to14: 0, gt14: 0, total: 0, oldestSentAt: null,
};

function bucketByAge(sentAt: Date, now: number): keyof Omit<LeakAgingBuckets, "total" | "oldestSentAt"> {
  const ms = now - sentAt.getTime();
  const dayMs = 24 * 3600 * 1000;
  if (ms < 1 * dayMs) return "lt1d";
  if (ms < 3 * dayMs) return "d1to3";
  if (ms < 7 * dayMs) return "d3to7";
  if (ms < 14 * dayMs) return "d7to14";
  return "gt14";
}

function bucketsFromSentAts(sentAts: Date[]): LeakAgingBuckets {
  if (sentAts.length === 0) return { ...EMPTY_BUCKETS };
  const now = Date.now();
  const out: LeakAgingBuckets = { ...EMPTY_BUCKETS, total: sentAts.length };
  let oldest = sentAts[0];
  for (const t of sentAts) {
    const k = bucketByAge(t, now);
    out[k] += 1;
    if (t.getTime() < oldest.getTime()) oldest = t;
  }
  out.oldestSentAt = oldest.toISOString();
  return out;
}

function utcDateKey(d: Date): string {
  // YYYY-MM-DD in UTC so day boundaries align across timezones.
  return d.toISOString().slice(0, 10);
}

/**
 * Phase 3 — analytics powering the Capture Leak Queue header strip.
 *
 *   • Resolution mix (7d / 30d): how many leaks were resolved in the
 *     window, split by `not_quote` / `ignored` (from `capture_leak_reviews`)
 *     and `created_quote` (from `quote_events.actor='manual_leak_create'`).
 *   • Aging buckets: current unresolved leaks (`buildLeakCandidateIds` —
 *     same chokepoint as the queue, so the totals match the badge) bucketed
 *     by sender-age (<1d, 1-3d, 3-7d, 7-14d, >14d).
 *   • Trendline (last 30d): per-day discovered-vs-resolved. Discovered
 *     reads the raw candidate set for the 30-day window (no review filter)
 *     so resolved rows still appear on their original discovery day.
 *
 * Same admin gating + rep-scope contract as `getLeakedQuoteEmails`. When
 * the caller has no funnel access (`__none__`), returns an empty shell.
 */
export async function getLeakAnalytics(
  orgId: string,
  scopedRepId: string | null | "__none__",
): Promise<LeakAnalyticsResult> {
  const trendWindowDays = 30;
  const agingWindowDays = 14; // mirrors the queue default
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();

  if (scopedRepId === "__none__") {
    return {
      agingWindowDays,
      trendWindowDays,
      generatedAt,
      resolutionMix: { sevenDay: { ...EMPTY_MIX }, thirtyDay: { ...EMPTY_MIX } },
      aging: { missedInbound: { ...EMPTY_BUCKETS }, orphanOutbound: { ...EMPTY_BUCKETS } },
      trend: emptyTrend(trendWindowDays, now),
    };
  }

  const since30 = new Date(now - 30 * 24 * 3600 * 1000);
  const since7 = new Date(now - 7 * 24 * 3600 * 1000);

  // ── Resolution mix sources ──────────────────────────────────────────
  const reviewRows = await db
    .select({
      decision: captureLeakReviews.decision,
      decidedAt: captureLeakReviews.decidedAt,
    })
    .from(captureLeakReviews)
    .where(and(
      eq(captureLeakReviews.organizationId, orgId),
      sql`${captureLeakReviews.decidedAt} >= ${since30}`,
    ));

  const manualCreateEvents = await db
    .select({ occurredAt: quoteEvents.occurredAt })
    .from(quoteEvents)
    .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteEvents.actor, "manual_leak_create"),
      sql`${quoteEvents.occurredAt} >= ${since30}`,
    ));

  const sevenDay: LeakResolutionMix = { ...EMPTY_MIX };
  const thirtyDay: LeakResolutionMix = { ...EMPTY_MIX };
  for (const r of reviewRows) {
    const t = r.decidedAt instanceof Date ? r.decidedAt : new Date(r.decidedAt);
    const inSeven = t.getTime() >= since7.getTime();
    if (r.decision === "not_quote") {
      thirtyDay.notQuote += 1;
      if (inSeven) sevenDay.notQuote += 1;
    } else if (r.decision === "ignored") {
      thirtyDay.ignored += 1;
      if (inSeven) sevenDay.ignored += 1;
    } else if (r.decision === "attached") {
      thirtyDay.attached += 1;
      if (inSeven) sevenDay.attached += 1;
    }
  }
  for (const e of manualCreateEvents) {
    const t = e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt);
    thirtyDay.createdQuote += 1;
    if (t.getTime() >= since7.getTime()) sevenDay.createdQuote += 1;
  }
  thirtyDay.total = thirtyDay.notQuote + thirtyDay.ignored + thirtyDay.createdQuote + thirtyDay.attached;
  sevenDay.total = sevenDay.notQuote + sevenDay.ignored + sevenDay.createdQuote + sevenDay.attached;

  // ── Aging buckets — current unresolved leaks ────────────────────────
  const candidates = await buildLeakCandidateIds(orgId, agingWindowDays);
  const agingIds = [...candidates.missedInboundIds, ...candidates.orphanOutboundIds];
  const sentAtById = new Map<string, Date>();
  if (agingIds.length > 0) {
    const rows = await db
      .select({ id: emailMessages.id, providerSentAt: emailMessages.providerSentAt })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        inArray(emailMessages.id, agingIds),
      ));
    for (const r of rows) {
      sentAtById.set(r.id, r.providerSentAt ?? new Date(0));
    }
  }
  const missedInboundBuckets = bucketsFromSentAts(
    candidates.missedInboundIds.map(id => sentAtById.get(id) ?? new Date(0)),
  );
  const orphanOutboundBuckets = bucketsFromSentAts(
    candidates.orphanOutboundIds.map(id => sentAtById.get(id) ?? new Date(0)),
  );

  // ── Trendline — discovered vs resolved per day ──────────────────────
  // Discovered reads the raw (pre-review-filter) candidate set so a
  // leak that was later reviewed still shows up on its discovery day.
  const raw30 = await buildRawLeakCandidates(orgId, trendWindowDays);
  const trendIndex = new Map<string, LeakTrendPoint>();
  for (let i = trendWindowDays - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 3600 * 1000);
    const key = utcDateKey(d);
    trendIndex.set(key, { date: key, discovered: 0, resolved: 0 });
  }
  for (const r of raw30.missedInbound) {
    const key = utcDateKey(r.providerSentAt);
    const point = trendIndex.get(key);
    if (point) point.discovered += 1;
  }
  for (const r of raw30.orphanOutbound) {
    const key = utcDateKey(r.providerSentAt);
    const point = trendIndex.get(key);
    if (point) point.discovered += 1;
  }
  for (const r of reviewRows) {
    const t = r.decidedAt instanceof Date ? r.decidedAt : new Date(r.decidedAt);
    const point = trendIndex.get(utcDateKey(t));
    if (point) point.resolved += 1;
  }
  for (const e of manualCreateEvents) {
    const t = e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt);
    const point = trendIndex.get(utcDateKey(t));
    if (point) point.resolved += 1;
  }
  const trend = Array.from(trendIndex.values());

  return {
    agingWindowDays,
    trendWindowDays,
    generatedAt,
    resolutionMix: { sevenDay, thirtyDay },
    aging: { missedInbound: missedInboundBuckets, orphanOutbound: orphanOutboundBuckets },
    trend,
  };
}

function emptyTrend(days: number, now: number): LeakTrendPoint[] {
  const out: LeakTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 3600 * 1000);
    out.push({ date: utcDateKey(d), discovered: 0, resolved: 0 });
  }
  return out;
}

// ─── Phase 2A — Capture leak review decisions ────────────────────────────

export type ReviewLeakRowStatus = "ok" | "not_found";

export interface ReviewLeakRowResult {
  status: ReviewLeakRowStatus;
  review?: CaptureLeakReview;
}

/**
 * Record (or overwrite) a "not a quote" / "ignored" decision for a single
 * capture-leak row. Idempotent via the
 * `(organization_id, message_id, leak_type)` unique index — replays from
 * the same admin or two admins racing each other collapse to one row.
 *
 * Cross-tenant safety: the `messageId` must belong to `orgId` in
 * `email_messages`. Passing a foreign-org id returns `not_found` and
 * writes nothing — so an admin in org A cannot guess at org B's ids and
 * silently mutate their leak queue.
 *
 * After a successful write, `buildLeakCandidateIds` will exclude the
 * `(messageId, leakType)` pair on its next call, so both
 * `getFunnelDiagnostics` counts AND `getLeakedQuoteEmails` rows update
 * in lock-step (no client-side hiding).
 */
export async function reviewLeakRow(
  orgId: string,
  userId: string | null,
  input: {
    messageId: string;
    leakType: CaptureLeakType;
    decision: CaptureLeakReviewDecision;
    note?: string | null;
  },
): Promise<ReviewLeakRowResult> {
  const messageId = input.messageId.trim();
  if (!messageId) return { status: "not_found" };

  // Cross-tenant safety. We deliberately don't check direction here —
  // both leak types come from `email_messages` and the leakType arg is
  // what tells us which queue the row belongs to. The route layer
  // validates leakType against the enum.
  const [msg] = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.id, messageId),
      eq(emailMessages.orgId, orgId),
    ))
    .limit(1);
  if (!msg) return { status: "not_found" };

  const note = (input.note ?? "").trim();
  const now = new Date();
  const [row] = await db
    .insert(captureLeakReviews)
    .values({
      organizationId: orgId,
      messageId,
      leakType: input.leakType,
      decision: input.decision,
      decidedByUserId: userId,
      note: note.length > 0 ? note : null,
    })
    .onConflictDoUpdate({
      target: [
        captureLeakReviews.organizationId,
        captureLeakReviews.messageId,
        captureLeakReviews.leakType,
      ],
      set: {
        decision: input.decision,
        decidedByUserId: userId,
        note: note.length > 0 ? note : null,
        updatedAt: now,
      },
    })
    .returning();

  return { status: "ok", review: row };
}

// ─── Phase 2B — Manual "Create quote" from a Missed Inbound leak row ─────

export type ManualLeakCreateStatus =
  | "created"          // a fresh quote_opportunities row was inserted
  | "duplicate"        // an existing quote already references this providerMessageId
  | "unparseable"      // ingestQuoteFromEmail couldn't extract a quote shape
  | "not_a_leak"       // race: row no longer in the leak set
  | "not_found"        // messageId doesn't belong to this org
  | "wrong_direction"; // outbound message — not a Missed Inbound row

export interface ManualLeakCreateResult {
  status: ManualLeakCreateStatus;
  quoteId?: string;
  reason?: string;
}

/**
 * Task #969 — options for `manuallyCreateQuoteFromLeakRow`.
 *
 * `forced=true` skips the "is this row still in the missed-inbound
 * candidate set?" race-guard. It is set by the rep-side "This should
 * be a quote" button in the conversation pane, where the rep is
 * looking at a specific inbound message that the classifier did NOT
 * flag as a leak (so it's not in `missedInboundIds`) but the rep
 * believes is a quote request anyway.
 *
 * `forced` does NOT bypass the cross-tenant or direction guards: an
 * outbound message or a message from another org still returns
 * `wrong_direction` / `not_found`. It also does NOT bypass the
 * `ingestQuoteFromEmail` idempotency — a duplicate `providerMessageId`
 * still resolves to `duplicate`.
 */
export interface ManualLeakCreateOpts {
  forced?: boolean;
}

/**
 * Manually convert a Missed Inbound leak row into a quote_opportunity.
 *
 * Reuses `ingestQuoteFromEmail` so parsing, idempotency (collision on
 * `(orgId, source="email", sourceReference=providerMessageId??id)`), customer
 * resolution, learned-mapping behaviour, and downstream events stay
 * identical to the autopilot pipeline. The only addition is a single
 * `quote_events` audit row written on a real "created" outcome — see below.
 *
 * Phase 2B is intentionally narrow: only inbound rows are accepted.
 * Orphan Outbound rows have no inbound payload to parse and are rejected
 * with `wrong_direction`. The route layer also restricts the UI to the
 * Missed Inbound tab so reaching this path with an outbound id requires
 * a hand-crafted request.
 *
 * Queue removal is implicit and drift-free: once the new quote exists,
 * `buildLeakCandidateIds` excludes its `sourceReference` via the
 * `existingQuoteRefs` set on the next refetch — so the row falls out of
 * BOTH the diagnostics counters and the queue list automatically. We
 * deliberately do NOT write a `captureLeakReviews` row for create —
 * the quote_opportunities row IS the resolution evidence, and writing a
 * second resolution marker would create two sources of truth.
 */
// Per-(orgId, messageId) in-process mutex. `ingestQuoteFromEmail` does a
// SELECT-then-INSERT on (organization_id, source, source_reference) but
// has no DB unique constraint — so two concurrent manual-create clicks
// (or one click racing the autopilot tick) could both pass the dup check
// and insert two rows. The autopilot tick is single-threaded per process,
// so we only need to serialize manual create calls against each other and
// against an already-running autopilot pass within the same process. This
// mirrors the `_batchInFlight` mutex pattern used by the email-intelligence
// scheduler. Keyed by (orgId :: messageId) — cross-tenant calls never
// share a slot.
const _manualLeakCreateInFlight = new Map<string, Promise<ManualLeakCreateResult>>();

export async function manuallyCreateQuoteFromLeakRow(
  orgId: string,
  userId: string,
  messageId: string,
  opts: ManualLeakCreateOpts = {},
): Promise<ManualLeakCreateResult> {
  const id = (messageId ?? "").trim();
  if (!id) return { status: "not_found" };

  const mutexKey = `${orgId}::${id}`;
  const existing = _manualLeakCreateInFlight.get(mutexKey);
  if (existing) {
    // A concurrent click (or another tick) is already creating this
    // exact (orgId, messageId). Await its result and return the same
    // outcome — both callers will see `created` (first) / `duplicate`
    // (second), never two distinct quote rows.
    return existing;
  }

  const work = _runManualLeakCreate(orgId, userId, id, opts);
  _manualLeakCreateInFlight.set(mutexKey, work);
  try {
    return await work;
  } finally {
    _manualLeakCreateInFlight.delete(mutexKey);
  }
}

// Test helpers — see captureLeakActions.test.ts.
export function _isManualLeakCreateInFlightForTests(orgId: string, messageId: string): boolean {
  return _manualLeakCreateInFlight.has(`${orgId}::${messageId}`);
}
export function _resetManualLeakCreateInFlightForTests(): void {
  _manualLeakCreateInFlight.clear();
}

async function _runManualLeakCreate(
  orgId: string,
  userId: string,
  id: string,
  opts: ManualLeakCreateOpts = {},
): Promise<ManualLeakCreateResult> {
  // 1) Cross-tenant + direction check. We must load the row so we can
  // (a) verify the message belongs to this org, (b) reject outbound
  // rows up-front, and (c) hand the EmailMessage to ingestQuoteFromEmail.
  const [msg] = await db.select().from(emailMessages).where(and(
    eq(emailMessages.id, id),
    eq(emailMessages.orgId, orgId),
  )).limit(1);
  if (!msg) return { status: "not_found" };
  if (msg.direction !== "inbound") return { status: "wrong_direction" };

  // 2) Race guard — between page load and click, another admin could
  // have reviewed the row, autopilot could have ingested it, or the
  // window could have rolled. Re-check the candidate set so we don't
  // create a quote for a row the user can no longer see. We use the
  // same default window as `getLeakedQuoteEmails` (14 days) so the
  // race-guard view matches what the UI was showing.
  //
  // Task #969 — `forced` skips this guard. The rep-side
  // "This should be a quote" button is invoked from the conversation
  // pane on a specific inbound that the classifier did NOT flag as
  // a leak. We still want the rep to be able to override that. The
  // dup-check inside `ingestQuoteFromEmail` keeps idempotency intact.
  if (!opts.forced) {
    const candidates = await buildLeakCandidateIds(orgId, 14);
    if (!candidates.missedInboundIds.includes(id)) {
      // It's possible the message was already converted to a quote by
      // the autopilot pipeline in the interim. Surface that quote so the
      // client can still deep-link to it (treated as `duplicate` below).
      const ref = msg.providerMessageId ?? msg.id;
      const [existing] = await db.select({ id: quoteOpportunities.id })
        .from(quoteOpportunities)
        .where(and(
          eq(quoteOpportunities.organizationId, orgId),
          eq(quoteOpportunities.source, "email"),
          eq(quoteOpportunities.sourceReference, ref),
        ))
        .limit(1);
      if (existing) return { status: "duplicate", quoteId: existing.id };
      return { status: "not_a_leak" };
    }
  }

  // 3) Hand off to the canonical ingestion path. `useAiFallback` is left
  // at its default (true) — manual triage is exactly when the AI fallback
  // should fire, since these are the rows the regex parser already
  // failed to capture. The function is idempotent on the providerMessageId.
  const result = await ingestQuoteFromEmail(msg);

  switch (result.status) {
    case "ingested": {
      const quoteId = result.quoteId!;
      // Audit trail: one `quote_events` row per manual creation, keyed
      // off the new quoteId. `eventType: "note"` keeps the existing
      // event-type vocabulary intact (no schema changes needed).
      try {
        await db.insert(quoteEvents).values({
          quoteId,
          eventType: "note",
          occurredAt: new Date(),
          actor: "manual_leak_create",
          payload: {
            source: "capture_leak_queue",
            messageId: id,
            triggeredByUserId: userId,
            leakType: "missed_inbound" as CaptureLeakType,
          },
        });
      } catch (err) {
        // Audit failures must not roll back a successful create.
        // Log and move on — the quote itself is what the user wanted.
        console.error("[capture-leak-create] failed to write audit event:", err);
      }
      return { status: "created", quoteId };
    }
    case "skipped_duplicate":
      return { status: "duplicate", quoteId: result.quoteId };
    case "skipped_unparseable":
      return { status: "unparseable", reason: "Could not extract a quote from this email" };
    case "skipped_outbound":
      // Defensive — we already filtered above, but the upstream contract
      // surfaces this status, so handle it explicitly rather than fall through.
      return { status: "wrong_direction" };
  }
}

// ─── Phase 4 — Attach Orphan Outbound row to an existing quote ────────────

export type AttachLeakStatus =
  | "attached"          // a fresh capture_leak_reviews(decision='attached') row inserted
  | "already_attached"  // (orgId,messageId,'orphan_outbound') already had a review row
  | "not_a_leak"        // race: row no longer in the orphan_outbound candidate set
  | "not_found"         // messageId doesn't belong to this org (or doesn't exist)
  | "wrong_leak_type"   // not an orphan_outbound row (direction != "outbound")
  | "invalid_quote";    // targetQuoteId not found in this org

export interface AttachLeakResult {
  status: AttachLeakStatus;
  quoteId?: string;
}

// Per-(orgId, messageId) in-process mutex — same pattern as
// `_manualLeakCreateInFlight`. Two concurrent admin clicks on the same
// row would both pass the "no existing review" check and both call
// `INSERT … ON CONFLICT DO NOTHING`; the unique index guarantees only
// one row, but the second caller's `quote_events` audit row would
// orphan-link to a decision they didn't make. Serializing per row makes
// the audit cleanly attribute to whichever click won the race.
const _leakAttachInFlight = new Map<string, Promise<AttachLeakResult>>();

/**
 * Extract the previously-attached quote id from a `capture_leak_reviews.note`
 * value. Notes for `decision='attached'` are stored as `attached:<qid>` so
 * the `attached:` prefix is stripped before the id is surfaced back to the
 * caller (the UI uses it for deep-linking). Returns undefined when the note
 * is empty or doesn't follow the expected shape — callers treat that as
 * "we know it's already attached but we don't have a deep-link target".
 */
function parseAttachedNoteQuoteId(note: string | null | undefined): string | undefined {
  const raw = (note ?? "").trim();
  if (!raw) return undefined;
  const stripped = raw.startsWith("attached:") ? raw.slice("attached:".length) : raw;
  const trimmed = stripped.trim();
  return trimmed || undefined;
}

/**
 * Attach an Orphan Outbound leak row to an existing quote_opportunity.
 *
 * Side effects on success ("attached"):
 *   1) Inserts a `capture_leak_reviews` row with `decision='attached'`
 *      (and `note` carrying the targetQuoteId for audit). The chokepoint
 *      `buildLeakCandidateIds` filters out ANY (messageId, leakType) with
 *      a review row, so the row drops out of the queue + diagnostics
 *      counters on the next refetch — same lock-step behaviour as the
 *      other decisions.
 *   2) Inserts a `quote_events` row with `actor='manual_leak_attach'`
 *      and `eventType='email_attached'`. This is audit/analytics input
 *      only — the chokepoint reads `capture_leak_reviews`, never
 *      `quote_events`.
 *
 * Cross-tenant safety: BOTH the email AND the target quote must belong
 * to `orgId`. A user in org A cannot attach an org A email to an org B
 * quote (or vice versa).
 *
 * Idempotency: the unique index on (orgId, messageId, leakType) is the
 * source of truth. A replay returns `already_attached` without writing
 * a second `quote_events` row (we only write the event on a fresh
 * insert).
 */
export async function attachOrphanOutboundToQuote(
  orgId: string,
  userId: string | null,
  messageId: string,
  targetQuoteId: string,
): Promise<AttachLeakResult> {
  const id = (messageId ?? "").trim();
  const qid = (targetQuoteId ?? "").trim();
  if (!id) return { status: "not_found" };
  if (!qid) return { status: "invalid_quote" };

  const mutexKey = `${orgId}::${id}`;
  const existing = _leakAttachInFlight.get(mutexKey);
  if (existing) return existing;

  const work = _runLeakAttach(orgId, userId, id, qid);
  _leakAttachInFlight.set(mutexKey, work);
  try {
    return await work;
  } finally {
    _leakAttachInFlight.delete(mutexKey);
  }
}

// Test helpers — see captureLeakAttach.test.ts.
export function _isLeakAttachInFlightForTests(orgId: string, messageId: string): boolean {
  return _leakAttachInFlight.has(`${orgId}::${messageId}`);
}
export function _resetLeakAttachInFlightForTests(): void {
  _leakAttachInFlight.clear();
}

async function _runLeakAttach(
  orgId: string,
  userId: string | null,
  id: string,
  qid: string,
): Promise<AttachLeakResult> {
  // 1) Cross-tenant + direction check on the email row.
  const [msg] = await db
    .select({
      id: emailMessages.id,
      direction: emailMessages.direction,
      providerMessageId: emailMessages.providerMessageId,
      threadId: emailMessages.threadId,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.id, id),
      eq(emailMessages.orgId, orgId),
    ))
    .limit(1);
  if (!msg) return { status: "not_found" };
  if (msg.direction !== "outbound") return { status: "wrong_leak_type" };

  // 2) Cross-tenant check on the target quote.
  const [quote] = await db
    .select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.id, qid),
      eq(quoteOpportunities.organizationId, orgId),
    ))
    .limit(1);
  if (!quote) return { status: "invalid_quote" };

  // 3) Race guard — the row must still be in the orphan_outbound
  //    candidate set. Same window as the queue default (14d) so the
  //    user's "is this row still attachable?" mental model matches what
  //    they were just looking at.
  const candidates = await buildLeakCandidateIds(orgId, 14);
  if (!candidates.orphanOutboundIds.includes(id)) {
    // Distinguish "already reviewed" from "no longer a candidate". If a
    // review row already exists, surface that as already_attached so the
    // UI can deep-link to the (note-stored) target quote on a re-click.
    const [reviewRow] = await db
      .select({
        decision: captureLeakReviews.decision,
        note: captureLeakReviews.note,
      })
      .from(captureLeakReviews)
      .where(and(
        eq(captureLeakReviews.organizationId, orgId),
        eq(captureLeakReviews.messageId, id),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ))
      .limit(1);
    if (reviewRow && reviewRow.decision === "attached") {
      // Recover the previously-attached quote id from the note. The
      // note is stored as `attached:<qid>` (see step 4 below) so we
      // strip the prefix before surfacing it to the caller.
      const noteQid = parseAttachedNoteQuoteId(reviewRow.note);
      return { status: "already_attached", quoteId: noteQid };
    }
    return { status: "not_a_leak" };
  }

  // 4) Insert the review row idempotently. We use INSERT … DO NOTHING
  //    rather than DO UPDATE because we want to detect the
  //    already_attached path (returning row count = 0) without
  //    overwriting the previous decision.
  const note = `attached:${qid}`;
  const inserted = await db
    .insert(captureLeakReviews)
    .values({
      organizationId: orgId,
      messageId: id,
      leakType: "orphan_outbound",
      decision: "attached",
      decidedByUserId: userId,
      note,
    })
    .onConflictDoNothing({
      target: [
        captureLeakReviews.organizationId,
        captureLeakReviews.messageId,
        captureLeakReviews.leakType,
      ],
    })
    .returning({ id: captureLeakReviews.id });

  if (inserted.length === 0) {
    // Another reviewer (or click) won the race. Surface the existing
    // attachment if its decision was 'attached' — otherwise report
    // already_attached without a quoteId so the UI can refresh.
    const [reviewRow] = await db
      .select({
        decision: captureLeakReviews.decision,
        note: captureLeakReviews.note,
      })
      .from(captureLeakReviews)
      .where(and(
        eq(captureLeakReviews.organizationId, orgId),
        eq(captureLeakReviews.messageId, id),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ))
      .limit(1);
    const prevQid = parseAttachedNoteQuoteId(reviewRow?.note ?? null);
    return { status: "already_attached", quoteId: prevQid };
  }

  // 5) Audit row. Failures here MUST NOT roll back the attachment —
  //    the resolution evidence is the capture_leak_reviews row above;
  //    the event is for analytics + the cross-tab feed.
  try {
    await db.insert(quoteEvents).values({
      quoteId: qid,
      eventType: "email_attached",
      occurredAt: new Date(),
      actor: "manual_leak_attach",
      payload: {
        source: "capture_leak_queue",
        messageId: id,
        providerMessageId: msg.providerMessageId,
        threadId: msg.threadId,
        leakType: "orphan_outbound" as CaptureLeakType,
        triggeredByUserId: userId,
        targetQuoteId: qid,
      },
    });
  } catch (err) {
    console.error("[capture-leak-attach] failed to write audit event:", err);
  }

  return { status: "attached", quoteId: qid };
}

// ─── Phase 4 — Attach candidate picker (open quotes for a row's customer) ─

export interface AttachCandidateQuote {
  quoteId: string;
  customerId: string;
  customerName: string;
  lane: string;
  equipment: string;
  outcomeStatus: string;
  requestDate: string;
  quotedAmount: string | null;
}

export interface ListAttachCandidatesResult {
  /** True when the row is linked to a known customer; the picker scopes
   *  to that customer. False ⇒ no scoping is possible and the picker
   *  surfaces an explanatory empty state. */
  customerScoped: boolean;
  customerId: string | null;
  customerName: string | null;
  /** "open" ⇒ open quotes (pending/quoted); "closed" ⇒ recent terminal
   *  quotes (won, any lost_*, no_response, expired) within the last 14d. */
  scope: "open" | "closed";
  quotes: AttachCandidateQuote[];
}

const OPEN_QUOTE_STATUSES = ["pending", "quoted"] as const;
const TERMINAL_QUOTE_STATUSES = [
  "won", "lost_price", "lost_service", "lost_timing", "lost_incumbent",
  "no_response", "expired", "won_low_margin",
] as const;

/**
 * List quote_opportunities rows that are valid attach targets for the
 * given orphan_outbound message. Scope:
 *
 *   • The message MUST belong to `orgId` and MUST be linked to a
 *     companies row (`emailMessages.linkedAccountId`). Without a linked
 *     customer we have no defensible default scope, so return an empty
 *     `customerScoped:false` shell — the UI explains and offers
 *     Open Thread / Not a Quote instead.
 *   • The companies row resolves to a quote_customers row by case-
 *     insensitive name match scoped to the same org. (We don't add a
 *     foreign key here — quote_customers and companies are different
 *     domains and the cross-link is intentionally name-based across the
 *     codebase.)
 *   • Default scope = open quotes for that customer, requestDate desc,
 *     capped at 25.
 *   • `closed:true` toggle = recent terminal quotes within last 14d,
 *     same cap.
 *   • Optional `q` substring filters on origin/dest/equipment/notes
 *     (case-insensitive, server-side).
 */
export async function listAttachCandidateQuotes(
  orgId: string,
  messageId: string,
  opts: { closed?: boolean; q?: string } = {},
): Promise<ListAttachCandidatesResult> {
  const closed = !!opts.closed;
  const scope: "open" | "closed" = closed ? "closed" : "open";
  const empty: ListAttachCandidatesResult = {
    customerScoped: false,
    customerId: null,
    customerName: null,
    scope,
    quotes: [],
  };

  const id = (messageId ?? "").trim();
  if (!id) return empty;

  const [msg] = await db
    .select({
      linkedAccountId: emailMessages.linkedAccountId,
      direction: emailMessages.direction,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.id, id),
      eq(emailMessages.orgId, orgId),
    ))
    .limit(1);
  if (!msg) return empty;
  if (msg.direction !== "outbound") return empty;
  if (!msg.linkedAccountId) return empty;

  const [account] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, msg.linkedAccountId))
    .limit(1);
  if (!account) return empty;

  // Resolve the companies row to a quote_customers row by case-insensitive
  // name within the same org. There may be multiple matches (legacy
  // dupes); we OR them all into the candidate query below.
  const customerRows = await db
    .select({ id: quoteCustomers.id, name: quoteCustomers.name })
    .from(quoteCustomers)
    .where(and(
      eq(quoteCustomers.organizationId, orgId),
      sql`LOWER(${quoteCustomers.name}) = LOWER(${account.name})`,
    ));
  if (customerRows.length === 0) {
    return {
      ...empty,
      customerScoped: true,
      customerId: null,
      customerName: account.name,
    };
  }

  const customerIds = customerRows.map(c => c.id);
  const statuses = closed
    ? [...TERMINAL_QUOTE_STATUSES] as string[]
    : [...OPEN_QUOTE_STATUSES] as string[];

  // For closed scope, restrict to the last 14d so the picker doesn't
  // surface ancient terminal rows that are clearly not what the user
  // is looking for.
  const recentSince = closed
    ? new Date(Date.now() - 14 * 24 * 3600 * 1000)
    : null;

  const conds = [
    eq(quoteOpportunities.organizationId, orgId),
    inArray(quoteOpportunities.customerId, customerIds),
    inArray(quoteOpportunities.outcomeStatus, statuses),
  ];
  if (recentSince) {
    conds.push(sql`${quoteOpportunities.requestDate} >= ${recentSince}`);
  }

  const q = (opts.q ?? "").trim();
  if (q.length > 0) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    conds.push(sql`(
      ${quoteOpportunities.originCity} ILIKE ${like}
      OR ${quoteOpportunities.originState} ILIKE ${like}
      OR ${quoteOpportunities.destCity} ILIKE ${like}
      OR ${quoteOpportunities.destState} ILIKE ${like}
      OR ${quoteOpportunities.equipment} ILIKE ${like}
      OR ${quoteOpportunities.notes} ILIKE ${like}
    )`);
  }

  const rows = await db
    .select({
      id: quoteOpportunities.id,
      customerId: quoteOpportunities.customerId,
      originCity: quoteOpportunities.originCity,
      originState: quoteOpportunities.originState,
      destCity: quoteOpportunities.destCity,
      destState: quoteOpportunities.destState,
      equipment: quoteOpportunities.equipment,
      outcomeStatus: quoteOpportunities.outcomeStatus,
      requestDate: quoteOpportunities.requestDate,
      quotedAmount: quoteOpportunities.quotedAmount,
    })
    .from(quoteOpportunities)
    .where(and(...conds))
    .orderBy(desc(quoteOpportunities.requestDate))
    .limit(25);

  const customerNameById = new Map(customerRows.map(c => [c.id, c.name]));
  return {
    customerScoped: true,
    customerId: customerRows[0].id, // representative
    customerName: account.name,
    scope,
    quotes: rows.map(r => ({
      quoteId: r.id,
      customerId: r.customerId,
      customerName: customerNameById.get(r.customerId) ?? account.name,
      lane: `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`,
      equipment: r.equipment,
      outcomeStatus: r.outcomeStatus,
      requestDate: r.requestDate.toISOString(),
      quotedAmount: r.quotedAmount,
    })),
  };
}

// ─── Task #803 — New-contact-review queue helpers ────────────────────────

export interface NewContactReviewItem {
  quoteId: string;
  customerId: string;
  customerName: string;
  senderEmail: string;
  senderName: string | null;
  detectedAt: string | null;
  lane: string;
  requestDate: string;
}

interface NewContactReviewPayload {
  senderEmail: string;
  senderName: string | null;
  customerId: string;
  customerName: string;
  detectedAt: string;
}

function readReviewPayload(raw: unknown): NewContactReviewPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const senderEmail = typeof r.senderEmail === "string" ? r.senderEmail : null;
  const customerId = typeof r.customerId === "string" ? r.customerId : null;
  const customerName = typeof r.customerName === "string" ? r.customerName : null;
  if (!senderEmail || !customerId || !customerName) return null;
  return {
    senderEmail,
    customerId,
    customerName,
    senderName: typeof r.senderName === "string" ? r.senderName : null,
    detectedAt: typeof r.detectedAt === "string" ? r.detectedAt : new Date().toISOString(),
  };
}

/**
 * List every pending new-contact-review prompt in the org. Sorted newest-
 * first so the rep sees the freshest customer activity at the top.
 */
export async function listNewContactReviews(
  orgId: string,
): Promise<NewContactReviewItem[]> {
  const rows = await db
    .select()
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      sql`${quoteOpportunities.needsNewContactReview} IS NOT NULL`,
    ))
    .orderBy(desc(quoteOpportunities.requestDate));
  const out: NewContactReviewItem[] = [];
  for (const r of rows) {
    const payload = readReviewPayload(r.needsNewContactReview);
    if (!payload) continue;
    out.push({
      quoteId: r.id,
      customerId: r.customerId,
      customerName: payload.customerName,
      senderEmail: payload.senderEmail,
      senderName: payload.senderName,
      detectedAt: payload.detectedAt,
      lane: `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState}`,
      requestDate: r.requestDate.toISOString(),
    });
  }
  return out;
}

export type NewContactReviewActionResult =
  | { status: "dismissed"; quoteId: string }
  | { status: "added"; quoteId: string; contactId: string; companyId: string }
  | { status: "not_found" }
  | { status: "no_pending_prompt" }
  | { status: "no_company_match" };

/**
 * Resolve a pending new-contact prompt. `action='dismiss'` simply clears
 * the JSONB flag; `action='add'` resolves the inbound sender's domain to
 * a CRM company and inserts a contacts row, then clears the flag.
 *
 * Both actions also write an `auto:new_sender` quote_event so the daily
 * summary alert can count it.
 */
export async function resolveNewContactReview(
  orgId: string,
  quoteId: string,
  action: "add" | "dismiss",
  actor: string,
  opts?: { name?: string; companyIdHint?: string | null },
): Promise<NewContactReviewActionResult> {
  const [opp] = await db
    .select()
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.id, quoteId),
    ))
    .limit(1);
  if (!opp) return { status: "not_found" };
  const payload = readReviewPayload(opp.needsNewContactReview);
  if (!payload) return { status: "no_pending_prompt" };

  let createdContactId: string | null = null;
  let resolvedCompanyId: string | null = null;
  if (action === "add") {
    // Prefer the explicit hint; otherwise resolve the company by sender
    // email domain. We never invent a brand-new company row from here —
    // if neither path yields one, surface a precise error so the UI can
    // route the rep into the manual contact-create flow instead.
    //
    // SECURITY (Task #803 review): the client-supplied companyIdHint MUST
    // be validated against the caller's org before being passed to
    // storage.createContact, otherwise an authenticated user could
    // create a contact under a company belonging to another tenant just
    // by guessing/knowing its UUID. We fall through to the
    // domain-matching path (which is org-scoped internally) if the hint
    // fails the cross-tenant check.
    let companyId: string | null = null;
    if (opts?.companyIdHint) {
      const owned = await storage.getCompanyInOrg(opts.companyIdHint, orgId);
      if (owned) companyId = owned.id;
    }
    if (!companyId) {
      const { matchAccountByEmailDomain } = await import("../routes/graphWebhook");
      companyId = await matchAccountByEmailDomain(payload.senderEmail, orgId).catch(() => null);
    }
    if (!companyId) return { status: "no_company_match" };
    const displayName = (opts?.name ?? "").trim() || payload.senderName || payload.senderEmail;
    const created = await storage.createContact({
      companyId,
      name: displayName,
      email: payload.senderEmail,
      sourceType: "quote_autopilot",
      isPrimary: false,
      status: "active",
    });
    createdContactId = created.id;
    resolvedCompanyId = companyId;
  }

  // Clear the flag and write the audit event together. We don't gate on
  // outcomeStatus here — even on a re-opened or already-quoted row the
  // prompt must clear once the rep acts on it.
  await db
    .update(quoteOpportunities)
    .set({ needsNewContactReview: null })
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.id, quoteId),
    ));

  // Suppress future prompts for this exact sender-email by writing an
  // email-level row into quote_sender_mappings. The DB CHECK constraint
  // requires EXACTLY ONE of (sender_email, sender_domain) be set, so we
  // explicitly pass senderDomain: null. The novelty-flagger in
  // quoteEmailIngestion.ts only triggers on domain-only matches
  // (`learned.senderDomain && !learned.senderEmail`), and `lookupMapping`
  // returns the email-level row in preference to the domain-level one,
  // so the presence of this email row short-circuits the prompt
  // permanently regardless of action (add/dismiss). We use the existing
  // `manual` source value (the only DB-supported value other than the
  // trigger-written `auto`) to comply with the existing schema contract;
  // the audit event below carries the more specific action context.
  // onConflictDoUpdate handles the race where a dismissal and add fire
  // back-to-back — the row keeps pointing at the latest customer.
  try {
    const senderEmailLc = payload.senderEmail.toLowerCase();
    await db
      .insert(quoteSenderMappings)
      .values({
        organizationId: orgId,
        senderEmail: senderEmailLc,
        senderDomain: null,
        customerId: payload.customerId,
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [quoteSenderMappings.organizationId, quoteSenderMappings.senderEmail],
        targetWhere: sql`${quoteSenderMappings.senderEmail} IS NOT NULL`,
        set: {
          customerId: sql`EXCLUDED.customer_id`,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    // Suppression is best-effort — failing here would block the rep from
    // dismissing the prompt, which is worse UX than the prompt resurfacing
    // on a future inbound from the same address.
    console.error("[resolveNewContactReview] sender mapping insert error:", err instanceof Error ? err.message : err);
  }

  await db.insert(quoteEvents).values({
    quoteId,
    eventType: "note",
    occurredAt: new Date(),
    actor: "auto:new_sender",
    payload: {
      source: "new_contact_review",
      action,
      resolvedBy: actor,
      senderEmail: payload.senderEmail,
      senderName: payload.senderName,
      customerId: payload.customerId,
      customerName: payload.customerName,
      contactId: createdContactId,
      companyId: resolvedCompanyId,
    },
  });

  if (action === "dismiss") return { status: "dismissed", quoteId };
  return {
    status: "added",
    quoteId,
    contactId: createdContactId!,
    companyId: resolvedCompanyId!,
  };
}

// =============================================================================
// Task #849 §3.1, §3.2, §3.3 — post-2d operator actions on quote opportunities.
//
// Three new operator-facing write paths (attach-to / send-to-leak / snooze)
// land here together because they share infrastructure: the in-process mutex
// pattern, the `quote_events` audit shape, the `publishLiveSync` cross-tab
// fan-out, and the `clearStaleFollowUpCache` invalidation. Keeping them in
// one block makes the contract surface easy to audit.
//
// Concurrency: each write path uses a per-key in-process Map<string,Promise>
// mutex (same pattern as `_leakAttachInFlight` above). The DB-side guards
// (unique indexes, conditional UPDATE WHERE clauses) make the operations
// idempotent on retry, but the mutex collapses concurrent clicks to a
// single set of audit rows so the timeline doesn't show ghost events.
//
// All three publish to `customer_quote` so the cross-tab UX layer wakes up
// the Quote Requests list immediately.
// =============================================================================

const QUOTE_TERMINAL_STATUSES = new Set<QuoteOutcomeStatus>([
  "won", "lost_price", "lost_service", "lost_timing", "lost_incumbent",
  "no_response", "expired", "won_low_margin",
]);

const QUOTE_TERMINAL_STATUSES_INCL_ATTACHED = new Set<QuoteOutcomeStatus>([
  ...Array.from(QUOTE_TERMINAL_STATUSES),
  "attached",
] as QuoteOutcomeStatus[]);

// ─── §3.1 attach-to ─────────────────────────────────────────────────────────

export type AttachQuoteStatus =
  | "attached"
  | "source_not_found"
  | "target_not_found"
  | "self_attach"
  | "already_closed"
  | "reattached";

export interface AttachQuoteResult {
  status: AttachQuoteStatus;
  fromOppId?: string;
  targetOppId?: string;
  capturedReviewIds?: string[];
  currentOutcome?: QuoteOutcomeStatus;
  /** Set on `reattached`: the previous target opp the source pointed at. */
  previousTargetOppId?: string;
}

const _attachQuoteInFlight = new Map<string, Promise<AttachQuoteResult>>();

/**
 * Attach a quote opportunity to a target opportunity (`§5.4 Attach` /
 * `§5.7 Mark duplicate`). Closes the source opp by setting
 * `outcome_status='attached'`, re-points its `email_signals` rows at the
 * target, and writes the audit pair `opp_attached_out` / `opp_attached_in`.
 *
 * Re-attach correction (elevated roles only): when the source opp is
 * ALREADY in `outcome_status='attached'` and `allowReattach=true`, the
 * function reads the source's most recent `opp_attached_out` event to
 * recover the `previousTargetOppId`, writes
 * `opp_reattached_out` / `opp_reattached_away` / a fresh `opp_attached_in`
 * on the new target, and re-points signals to the new target. The
 * `publishLiveSync` fan-out covers all three opps.
 *
 * Mutex key: `attach:${orgId}:${sourceOppId}:${targetOppId}` — concurrent
 * clicks with identical inputs collapse to a single set of writes.
 */
export async function attachQuoteToTarget(
  orgId: string,
  userId: string | null,
  sourceOppId: string,
  targetOppId: string,
  decision: "attached" | "duplicate",
  note: string | null,
  allowReattach: boolean,
): Promise<AttachQuoteResult> {
  const sid = (sourceOppId ?? "").trim();
  const tid = (targetOppId ?? "").trim();
  if (!sid) return { status: "source_not_found" };
  if (!tid) return { status: "target_not_found" };
  if (sid === tid) return { status: "self_attach" };

  const mutexKey = `attach:${orgId}:${sid}:${tid}`;
  const inFlight = _attachQuoteInFlight.get(mutexKey);
  if (inFlight) return inFlight;
  const work = _runAttachQuote(orgId, userId, sid, tid, decision, note, allowReattach);
  _attachQuoteInFlight.set(mutexKey, work);
  try {
    return await work;
  } finally {
    _attachQuoteInFlight.delete(mutexKey);
  }
}

export function _isAttachQuoteInFlightForTests(orgId: string, sid: string, tid: string): boolean {
  return _attachQuoteInFlight.has(`attach:${orgId}:${sid}:${tid}`);
}

async function _runAttachQuote(
  orgId: string,
  userId: string | null,
  sid: string,
  tid: string,
  decision: "attached" | "duplicate",
  note: string | null,
  allowReattach: boolean,
): Promise<AttachQuoteResult> {
  const [source] = await db.select({
    id: quoteOpportunities.id,
    outcomeStatus: quoteOpportunities.outcomeStatus,
  }).from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    eq(quoteOpportunities.id, sid),
  )).limit(1);
  if (!source) return { status: "source_not_found" };

  const [target] = await db.select({ id: quoteOpportunities.id }).from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    eq(quoteOpportunities.id, tid),
  )).limit(1);
  if (!target) return { status: "target_not_found" };

  const isReattach = source.outcomeStatus === "attached";
  // Terminal-state guard. `attached` is the only terminal state that
  // re-routes (correction path) — every other terminal is a hard stop.
  if (QUOTE_TERMINAL_STATUSES.has(source.outcomeStatus as QuoteOutcomeStatus)) {
    return { status: "already_closed", currentOutcome: source.outcomeStatus as QuoteOutcomeStatus };
  }
  if (isReattach && !allowReattach) {
    return { status: "already_closed", currentOutcome: source.outcomeStatus as QuoteOutcomeStatus };
  }

  // Recover previous target for the re-attach correction path. The
  // payload of the most recent `opp_attached_out` event on the source
  // carries the targetOppId of the prior attach.
  let previousTargetOppId: string | undefined;
  if (isReattach) {
    const [prevEv] = await db.select({ payload: quoteEvents.payload })
      .from(quoteEvents)
      .where(and(
        eq(quoteEvents.quoteId, sid),
        eq(quoteEvents.eventType, "opp_attached_out"),
      ))
      .orderBy(desc(quoteEvents.occurredAt))
      .limit(1);
    const prevPayload = (prevEv?.payload ?? null) as { targetOppId?: string } | null;
    previousTargetOppId = prevPayload?.targetOppId ?? undefined;
    // Re-attach to the SAME prior target is a no-op — surface
    // already_closed so the UI re-renders without a duplicate audit row.
    if (previousTargetOppId === tid) {
      return { status: "already_closed", currentOutcome: "attached", previousTargetOppId };
    }
  }

  const now = new Date();

  // 1) Re-point signals from source → target.
  await db.update(emailSignals)
    .set({ linkedOpportunityId: tid })
    .where(eq(emailSignals.linkedOpportunityId, sid));

  // 2) Update the source opp's outcome (only if not already 'attached').
  if (!isReattach) {
    await db.update(quoteOpportunities)
      .set({ outcomeStatus: "attached", outcomeReasonId: null })
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        eq(quoteOpportunities.id, sid),
      ));
  }

  // 3) Write the audit-event pair (or trio for re-attach).
  const eventType_out = isReattach ? "opp_reattached_out" : "opp_attached_out";
  const eventType_in = "opp_attached_in";
  const payload_out = {
    targetOppId: tid,
    decision,
    note,
    byUserId: userId,
    ...(isReattach ? { previousTargetOppId } : {}),
  };
  const payload_in = { fromOppId: sid, decision, note, byUserId: userId };

  await db.insert(quoteEvents).values({
    quoteId: sid,
    eventType: eventType_out,
    occurredAt: now,
    actor: "manual_leak_attach",
    payload: payload_out,
  });
  await db.insert(quoteEvents).values({
    quoteId: tid,
    eventType: eventType_in,
    occurredAt: now,
    actor: "manual_leak_attach",
    payload: payload_in,
  });
  if (isReattach && previousTargetOppId) {
    await db.insert(quoteEvents).values({
      quoteId: previousTargetOppId,
      eventType: "opp_reattached_away",
      occurredAt: now,
      actor: "manual_leak_attach",
      payload: { fromOppId: sid, newTargetOppId: tid, byUserId: userId },
    });
  }

  // 4) Upsert capture_leak_reviews for every inbound message that the
  // source opp's signals reference. We collect these BEFORE the signal
  // update above already re-pointed them — so we walk the SOURCE-side
  // history through the audit chain instead. Practically: re-find any
  // inbound `email_messages.id` whose `email_signals` row was just
  // re-pointed (by reading provider_message_id off the source opp's
  // sourceReference is unreliable for multi-message threads).
  // Since we already re-pointed, query the now-target signals for
  // anything that was just moved.
  const movedMsgIds = await db
    .select({
      messageId: emailSignals.messageId,
    })
    .from(emailSignals)
    .where(eq(emailSignals.linkedOpportunityId, tid));

  const seen = new Set<string>();
  const reviewIds: string[] = [];
  for (const r of movedMsgIds) {
    const mid = r.messageId;
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    try {
      const [inserted] = await db.insert(captureLeakReviews).values({
        organizationId: orgId,
        messageId: mid,
        leakType: "missed_inbound",
        decision,
        decidedByUserId: userId,
        note: note ?? `attached:${tid}`,
      }).onConflictDoUpdate({
        target: [
          captureLeakReviews.organizationId,
          captureLeakReviews.messageId,
          captureLeakReviews.leakType,
        ],
        set: {
          decision,
          decidedByUserId: userId,
          note: note ?? `attached:${tid}`,
        },
      }).returning({ id: captureLeakReviews.id });
      if (inserted?.id) reviewIds.push(inserted.id);
    } catch (err) {
      console.error("[attach-to] capture_leak_reviews upsert failed:", err);
    }
  }

  // 5) Cross-tab fan-out + cache invalidation.
  publishLiveSyncFromService(orgId, "customer_quote", sid);
  publishLiveSyncFromService(orgId, "customer_quote", tid);
  if (isReattach && previousTargetOppId) {
    publishLiveSyncFromService(orgId, "customer_quote", previousTargetOppId);
  }
  try {
    const { clearStaleFollowUpCache } = await import("./staleQuoteFollowup");
    clearStaleFollowUpCache(orgId);
  } catch { /* cache invalidation must not fail the write */ }

  return {
    status: isReattach ? "reattached" : "attached",
    fromOppId: sid,
    targetOppId: tid,
    capturedReviewIds: reviewIds,
    previousTargetOppId,
  };
}

// ─── §3.2 send-to-leak ──────────────────────────────────────────────────────

export type SendToLeakReason =
  | "not_a_request"
  | "unparseable"
  | "wrong_party"
  | "duplicate_email"
  | "other";

export type SendToLeakStatus =
  | "sent_to_leak"
  | "not_found"
  | "already_closed";

export interface SendToLeakResult {
  status: SendToLeakStatus;
  oppId?: string;
  decision?: "not_a_request" | "returned_to_queue";
  capturedReviewIds?: string[];
  senderSuppressed?: boolean;
  currentOutcome?: QuoteOutcomeStatus;
}

const _sendToLeakInFlight = new Map<string, Promise<SendToLeakResult>>();

const SENT_TO_LEAK_REASON_CODE = "sent_to_leak_queue";
const SENT_TO_LEAK_REASON_LABEL = "Sent to leak queue";

async function findOrCreateSentToLeakReason(orgId: string): Promise<string> {
  const [existing] = await db.select({ id: quoteOutcomeReasons.id })
    .from(quoteOutcomeReasons)
    .where(and(
      eq(quoteOutcomeReasons.organizationId, orgId),
      eq(quoteOutcomeReasons.code, SENT_TO_LEAK_REASON_CODE),
    )).limit(1);
  if (existing) return existing.id;
  const [row] = await db.insert(quoteOutcomeReasons).values({
    organizationId: orgId,
    code: SENT_TO_LEAK_REASON_CODE,
    label: SENT_TO_LEAK_REASON_LABEL,
    category: "no_response",
  }).returning({ id: quoteOutcomeReasons.id });
  return row.id;
}

/**
 * Send a quote opportunity to the leak queue (§5.6 / §5.13). Closes the
 * opp with `outcome_status='no_response'` + a `sent_to_leak_queue`
 * outcome reason, upserts `capture_leak_reviews` rows for each linked
 * inbound email, and either restores the signal to "leaked"
 * (`returned_to_queue`) or leaves the opp linkage intact
 * (`not_a_request`).
 */
export async function sendQuoteToLeak(
  orgId: string,
  userId: string | null,
  oppId: string,
  reason: SendToLeakReason,
  note: string | null,
  suppressSender: boolean,
): Promise<SendToLeakResult> {
  const id = (oppId ?? "").trim();
  if (!id) return { status: "not_found" };
  const mutexKey = `send-to-leak:${orgId}:${id}`;
  const inFlight = _sendToLeakInFlight.get(mutexKey);
  if (inFlight) return inFlight;
  const work = _runSendQuoteToLeak(orgId, userId, id, reason, note, suppressSender);
  _sendToLeakInFlight.set(mutexKey, work);
  try {
    return await work;
  } finally {
    _sendToLeakInFlight.delete(mutexKey);
  }
}

export function _isSendToLeakInFlightForTests(orgId: string, oppId: string): boolean {
  return _sendToLeakInFlight.has(`send-to-leak:${orgId}:${oppId}`);
}

async function _runSendQuoteToLeak(
  orgId: string,
  userId: string | null,
  id: string,
  reason: SendToLeakReason,
  note: string | null,
  suppressSender: boolean,
): Promise<SendToLeakResult> {
  const [opp] = await db.select({
    id: quoteOpportunities.id,
    outcomeStatus: quoteOpportunities.outcomeStatus,
    sourceReference: quoteOpportunities.sourceReference,
  }).from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, orgId),
    eq(quoteOpportunities.id, id),
  )).limit(1);
  if (!opp) return { status: "not_found" };
  if (QUOTE_TERMINAL_STATUSES_INCL_ATTACHED.has(opp.outcomeStatus as QuoteOutcomeStatus)) {
    return { status: "already_closed", currentOutcome: opp.outcomeStatus as QuoteOutcomeStatus };
  }

  const decision: "not_a_request" | "returned_to_queue" =
    reason === "not_a_request" ? "not_a_request" : "returned_to_queue";
  const reasonId = await findOrCreateSentToLeakReason(orgId);
  const now = new Date();

  // 1) Close the opp.
  await db.update(quoteOpportunities)
    .set({ outcomeStatus: "no_response", outcomeReasonId: reasonId })
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.id, id),
    ));

  // 2) Audit event.
  await db.insert(quoteEvents).values({
    quoteId: id,
    eventType: "sent_to_leak",
    occurredAt: now,
    actor: "rep_send_to_leak",
    payload: { reason, note, byUserId: userId, decision },
  });

  // 3) Capture reviews for every linked inbound message.
  const linkedSignals = await db.select({ messageId: emailSignals.messageId })
    .from(emailSignals)
    .where(eq(emailSignals.linkedOpportunityId, id));
  const seen = new Set<string>();
  const reviewIds: string[] = [];
  for (const r of linkedSignals) {
    const mid = r.messageId;
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    try {
      const [inserted] = await db.insert(captureLeakReviews).values({
        organizationId: orgId,
        messageId: mid,
        leakType: "missed_inbound",
        decision,
        decidedByUserId: userId,
        note: note ?? null,
      }).onConflictDoUpdate({
        target: [
          captureLeakReviews.organizationId,
          captureLeakReviews.messageId,
          captureLeakReviews.leakType,
        ],
        set: { decision, decidedByUserId: userId, note: note ?? null },
      }).returning({ id: captureLeakReviews.id });
      if (inserted?.id) reviewIds.push(inserted.id);
    } catch (err) {
      console.error("[send-to-leak] capture_leak_reviews upsert failed:", err);
    }
  }

  // 4) returned_to_queue → restore the signal to "leaked" by clearing
  // BOTH `email_signals.linked_opportunity_id` AND
  // `quote_opportunities.source_reference` (per §3.2 step 5 of the
  // contract — leakage-stats classifier reads both).
  if (decision === "returned_to_queue") {
    await db.update(emailSignals)
      .set({ linkedOpportunityId: null })
      .where(eq(emailSignals.linkedOpportunityId, id));
    await db.update(quoteOpportunities)
      .set({ sourceReference: null })
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        eq(quoteOpportunities.id, id),
      ));
  }

  // 5) Sender suppression (best effort — failure must not block the
  // send-to-leak success). Only meaningful when the rep declared the
  // sender was sending non-quote content (`not_a_request`).
  let senderSuppressed = false;
  if (reason === "not_a_request" && suppressSender) {
    try {
      // Resolve the inbound sender. The opp's `sourceReference` carries
      // the provider_message_id; we walk it back to email_messages to
      // find from_email.
      let fromEmail: string | null = null;
      if (opp.sourceReference) {
        const [msg] = await db.select({ fromEmail: emailMessages.fromEmail })
          .from(emailMessages)
          .where(and(
            eq(emailMessages.orgId, orgId),
            eq(emailMessages.providerMessageId, opp.sourceReference),
          ))
          .limit(1);
        fromEmail = msg?.fromEmail ?? null;
      }
      if (!fromEmail) {
        // Fall back to the most recent inbound on the opp's signal set.
        const [linked] = await db.select({ fromEmail: emailMessages.fromEmail })
          .from(emailSignals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailSignals.messageId))
          .where(eq(emailSignals.linkedOpportunityId, id))
          .orderBy(desc(emailMessages.providerSentAt))
          .limit(1);
        fromEmail = linked?.fromEmail ?? null;
      }
      const { extractSenderInfo } = await import("./quoteSenderMappings");
      const info = extractSenderInfo(fromEmail);
      if (info) {
        // Insert the suppression mapping. Reuse the org-scoped semantics
        // of the existing table; we deliberately do NOT use the
        // customer-routing helpers (`upsertManualMapping`) because those
        // require a customerId. Suppression rows are customerId=NULL.
        await db.insert(quoteSenderMappings).values({
          organizationId: orgId,
          senderDomain: info.isFreeMail ? null : info.domain,
          senderEmail: info.email,
          customerId: null,
          suppressed: true,
          source: "manual",
        });
        senderSuppressed = true;
      }
    } catch (err) {
      // Don't fail the whole call — just log so the operator sees the
      // suppression didn't take. They can retry via the senders admin.
      console.error("[send-to-leak] sender suppression failed:", err);
    }
  }

  publishLiveSyncFromService(orgId, "customer_quote", id);
  try {
    const { clearStaleFollowUpCache } = await import("./staleQuoteFollowup");
    clearStaleFollowUpCache(orgId);
  } catch { /* fire-and-forget */ }

  return {
    status: "sent_to_leak",
    oppId: id,
    decision,
    capturedReviewIds: reviewIds,
    senderSuppressed,
  };
}

// ─── §3.3 snooze ────────────────────────────────────────────────────────────

export type SnoozeQuoteStatus =
  | "snoozed"
  | "unsnoozed"
  | "not_found";

export interface SnoozeQuoteResult {
  status: SnoozeQuoteStatus;
  oppId?: string;
  snoozedUntil?: string | null;
}

const SNOOZE_MAX_FUTURE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Snooze (or unsnooze) a quote opportunity (§5.8 / §5.9). Hides the
 * row from the default Quote Requests list until `snoozedUntil`. Pass
 * `null` to clear. Idempotent — last write wins, no mutex needed.
 *
 * Caller must have ALREADY validated the date window (>now, ≤+14d) at
 * the route level and returned `400 invalid_body` for misuse — this
 * service expects a clean ISO string or null.
 */
export async function snoozeQuote(
  orgId: string,
  userId: string | null,
  oppId: string,
  snoozedUntilIso: string | null,
): Promise<SnoozeQuoteResult> {
  const id = (oppId ?? "").trim();
  if (!id) return { status: "not_found" };
  const [opp] = await db.select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.id, id),
    )).limit(1);
  if (!opp) return { status: "not_found" };

  const snoozedUntil = snoozedUntilIso ? new Date(snoozedUntilIso) : null;
  await db.update(quoteOpportunities)
    .set({ snoozedUntil })
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.id, id),
    ));

  const eventType = snoozedUntilIso ? "snoozed" : "unsnoozed";
  await db.insert(quoteEvents).values({
    quoteId: id,
    eventType,
    occurredAt: new Date(),
    actor: "rep_snooze",
    payload: { snoozedUntil: snoozedUntilIso, byUserId: userId },
  });

  publishLiveSyncFromService(orgId, "customer_quote", id);

  return {
    status: snoozedUntilIso ? "snoozed" : "unsnoozed",
    oppId: id,
    snoozedUntil: snoozedUntilIso,
  };
}

export const SNOOZE_QUOTE_LIMITS = {
  MAX_FUTURE_MS: SNOOZE_MAX_FUTURE_MS,
} as const;

// Cross-tab fan-out helper — a thin wrapper that swallows the dynamic
// import boilerplate (the live-sync module is the same one routes call
// directly via `publish as publishLiveSync`). Inlined here to keep the
// service file self-contained without forcing the import at top-of-file
// (which would create a circular dep risk in a few entrypoints).
function publishLiveSyncFromService(
  orgId: string,
  topic: string,
  key?: string,
  rowVersionAt?: number,
): void {
  try {
    // Lazy require so the service stays importable from worker entrypoints
    // that don't pull in the live-sync emitter eagerly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const liveSync = require("./liveSync");
    // Task #967 — default rowVersionAt to Date.now() at publish time so
    // every customer_quote event participates in the client-side
    // out-of-order guard. Publishes are emitted in commit order, so
    // their wall-clock at publish is monotonic per (orgId, key) — the
    // exact contract `applyRowVersionGuard` relies on.
    const ver = typeof rowVersionAt === "number" ? rowVersionAt : Date.now();
    liveSync.publish(orgId, topic, key, ver);
  } catch {
    // Live-sync is advisory; never fail a write because of it.
  }
}

// =============================================================================
// Quote Requests freshness — trust-visibility strip on /quote-requests.
//
// Surfaces three honest facts so the page can never silently show "0/0" again
// without explaining why:
//   1. lastRunAt          — wall-clock of the most recent email_intelligence
//                           batch tick (success preferred; falls back to last
//                           started so we don't go dark while a batch is in
//                           flight).
//   2. inboundToday       — count of inbound emails received today (UTC).
//                           Uses provider_sent_at so messages back-dated by
//                           a self-heal sweep aren't counted as "today".
//   3. oppsToday          — count of quote_opportunities with request_date
//                           today (UTC). Matches the dayStart computation
//                           getSnapshot uses for its autoCapturedToday KPI.
//
// processingHint.show fires only when the gap between inbound and opps is
// material (≥ HINT_MIN_GAP). Steady-state is gap≈0; the morning back-load
// regression that triggered this work shows gap=hundreds.
// =============================================================================
const FRESHNESS_HINT_MIN_GAP = 20;

export type QuoteFreshness = {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lagSeconds: number | null;
  inboundToday: number;
  oppsToday: number;
  processingHint: { show: boolean; pendingCount: number };
};

export async function getQuoteFreshness(orgId: string): Promise<QuoteFreshness> {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  // Email-intelligence scheduler heartbeat. Sourced from JOB_NAMES so a
  // future rename of the job stays in lockstep with this read path.
  const [hb] = await db
    .select()
    .from(cronHeartbeats)
    .where(eq(cronHeartbeats.jobName, JOB_NAMES.emailIntelligenceBatch))
    .limit(1);

  // Prefer last finished tick; fall back to last started so a long-running
  // batch doesn't make the strip read "no recent run".
  const lastRunDate = hb?.lastFinishedAt ?? hb?.lastStartedAt ?? null;
  const lagSeconds = lastRunDate
    ? Math.max(0, Math.floor((now.getTime() - lastRunDate.getTime()) / 1000))
    : null;

  const [inboundRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.direction, "inbound"),
      sql`coalesce(${emailMessages.providerSentAt}, ${emailMessages.createdAt}) >= ${dayStart}`,
    ));

  const [oppsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      sql`${quoteOpportunities.requestDate} >= ${dayStart}`,
    ));

  const inboundToday = inboundRow?.count ?? 0;
  const oppsToday = oppsRow?.count ?? 0;
  const gap = inboundToday - oppsToday;
  const show = gap >= FRESHNESS_HINT_MIN_GAP;

  return {
    lastRunAt: lastRunDate ? lastRunDate.toISOString() : null,
    lastRunStatus: hb?.lastStatus ?? null,
    lagSeconds,
    inboundToday,
    oppsToday,
    processingHint: { show, pendingCount: show ? gap : 0 },
  };
}

// Test-only exports — internal helpers exposed for unit tests, not for runtime use.
export const __testables = { enrich };
