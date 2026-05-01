/**
 * Task #911 — Document Entity Resolver.
 *
 * Given a typed extraction (rate-con today, other classes later), finds
 * matching internal CRM records and writes them to `document_entity_links`
 * with a per-candidate score + signal. Never silently picks: whenever
 * more than one candidate clears the floor for the same kind, the
 * document is flipped to `needs_review`, no `isPrimary` flag is set on
 * any of them, and the rep disambiguates from the doc UI. The previous
 * "top vs runner-up within 0.05 tie-break" was too permissive — multiple
 * plausible matches must always be a rep decision (Task #911 spec).
 *
 * Resolution order per kind:
 *   carrier      — MC# exact > DOT# exact > fuzzy name (Jaro-Winkler-ish)
 *   customer     — broker/shipper name exact > fuzzy with confidence floor
 *                  (companies.name first, then quote_customers.name fallback)
 *   lane         — (origin city/state, dest city/state) exact in load_fact
 *                  > 3-digit ZIP fallback (origin_zip[0..3] + dest_zip[0..3])
 *   quote        — quote_opportunities matching customerId × origin/dest ×
 *                  request date within window
 *   load         — load_fact.orderId == loadReference / proNumber
 *   opportunity  — freight_opportunities matching companyId × origin/dest
 *                  with status not closed
 */
import { db, storage } from "../storage";
import { and, eq, ilike, inArray, or, sql, desc, gte, lte, isNotNull } from "drizzle-orm";
import {
  carriers,
  companies,
  quoteCustomers,
  quoteOpportunities,
  loadFact,
  freightOpportunities,
  recurringLanes,
  type RateConExtraction,
  type InsertDocumentEntityLink,
  type EntityLinkKind,
} from "@shared/schema";

// Confidence floors per kind. Below the floor we DROP the candidate
// (so it doesn't clutter the rep UI). When two candidates clear the
// floor for the same kind, we mark needs_review.
const FLOORS: Record<EntityLinkKind, number> = {
  carrier: 0.55,
  customer: 0.6,
  lane: 0.55,
  quote: 0.6,
  load: 0.7,
  opportunity: 0.6,
};

const MAX_CANDIDATES_PER_KIND = 3;
const QUOTE_LOOKBACK_DAYS = 30;

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export interface ResolveEntitiesResult {
  links: InsertDocumentEntityLink[];
  needsReview: boolean;
  ambiguousKinds: EntityLinkKind[];
  noMatchKinds: EntityLinkKind[];
}

export async function resolveRateConEntities(args: {
  documentId: string;
  organizationId: string;
  payload: RateConExtraction;
  /** Persist via storage.replaceDocumentEntityLinks. Default: true. */
  persist?: boolean;
}): Promise<ResolveEntitiesResult> {
  const { documentId, organizationId, payload } = args;

  // Run resolvers in parallel — they're independent reads.
  const [carrierC, customerC, laneC, loadC] = await Promise.all([
    resolveCarrier(organizationId, payload),
    resolveCustomer(organizationId, payload),
    resolveLane(organizationId, payload),
    resolveLoad(organizationId, payload),
  ]);

  // Quote + opportunity depend on the resolved customer.
  const primaryCustomer = pickPrimary(customerC);
  const [quoteC, opportunityC] = await Promise.all([
    resolveQuote(organizationId, payload, primaryCustomer),
    resolveOpportunity(organizationId, payload, primaryCustomer),
  ]);

  const allCandidates: Record<EntityLinkKind, ScoredCandidate[]> = {
    carrier: carrierC,
    customer: customerC,
    lane: laneC,
    load: loadC,
    quote: quoteC,
    opportunity: opportunityC,
  };

  const links: InsertDocumentEntityLink[] = [];
  const ambiguousKinds: EntityLinkKind[] = [];
  const noMatchKinds: EntityLinkKind[] = [];
  for (const [kind, cands] of Object.entries(allCandidates) as Array<[EntityLinkKind, ScoredCandidate[]]>) {
    const surviving = cands.filter((c) => c.score >= FLOORS[kind]).slice(0, MAX_CANDIDATES_PER_KIND);
    if (surviving.length === 0) {
      noMatchKinds.push(kind);
      continue;
    }
    // Strict policy (Task #911): if more than one candidate clears the
    // floor for a kind, the doc is ambiguous for that kind — never
    // silently pick a primary. The rep must disambiguate from the UI.
    // Single survivors auto-promote to primary.
    const ambiguous = surviving.length > 1;
    if (ambiguous) ambiguousKinds.push(kind);
    surviving.forEach((c, idx) => {
      links.push({
        documentId,
        organizationId,
        kind,
        targetTable: c.targetTable,
        targetId: c.targetId,
        targetLabel: c.targetLabel,
        matchScore: c.score.toFixed(3),
        matchSignal: c.signal,
        candidateRank: idx + 1,
        isPrimary: idx === 0 && !ambiguous,
      });
    });
  }

  if (args.persist !== false) {
    await storage.replaceDocumentEntityLinks(documentId, organizationId, links);
  }

  const needsReview = ambiguousKinds.length > 0;
  return { links, needsReview, ambiguousKinds, noMatchKinds };
}

// ──────────────────────────────────────────────────────────────────────
// Per-kind resolvers
// ──────────────────────────────────────────────────────────────────────

interface ScoredCandidate {
  targetTable: string;
  targetId: string;
  targetLabel: string | null;
  score: number;
  signal: string;
}

function pickPrimary(cands: ScoredCandidate[]): ScoredCandidate | null {
  // Same strict policy as the public resolver — never silently pick when
  // more than one candidate clears the per-kind floor for the same kind.
  // For internal use (quote/opportunity follow-on lookups) we treat any
  // multi-candidate set as ambiguous and skip the dependent search.
  const surviving = cands.filter((c) => c.score >= FLOORS.customer);
  if (surviving.length !== 1) return null;
  return surviving[0];
}

async function resolveCarrier(orgId: string, payload: RateConExtraction): Promise<ScoredCandidate[]> {
  const out: ScoredCandidate[] = [];
  const mc = digitsOnly(payload.carrierMcNumber.value);
  const dot = digitsOnly(payload.carrierDotNumber.value);
  const name = (payload.carrierName.value ?? "").trim();

  // 1. MC# exact (highest signal — every legit broker writes the MC).
  if (mc) {
    const rows = await db.select().from(carriers).where(and(
      eq(carriers.orgId, orgId),
      or(eq(carriers.mcDot, mc), ilike(carriers.mcDot, `%${mc}%`)),
    )).limit(5);
    rows.forEach((r) => out.push({
      targetTable: "carriers",
      targetId: r.id,
      targetLabel: r.name,
      score: 0.97,
      signal: `mc_exact:${mc}`,
    }));
  }

  // 2. DOT# exact.
  if (dot && out.length === 0) {
    const rows = await db.select().from(carriers).where(and(
      eq(carriers.orgId, orgId),
      or(eq(carriers.dotNumber, dot), eq(carriers.mcDot, dot)),
    )).limit(5);
    rows.forEach((r) => out.push({
      targetTable: "carriers",
      targetId: r.id,
      targetLabel: r.name,
      score: 0.92,
      signal: `dot_exact:${dot}`,
    }));
  }

  // 3. Fuzzy name (only when MC/DOT didn't hit).
  if (out.length === 0 && name.length >= 3) {
    const cleaned = stripCorpSuffixes(name).toLowerCase();
    const rows = await db.select().from(carriers).where(and(
      eq(carriers.orgId, orgId),
      or(ilike(carriers.name, `%${name}%`), ilike(carriers.legalName, `%${name}%`)),
    )).limit(10);
    rows.forEach((r) => {
      const score = nameSimilarity(cleaned, stripCorpSuffixes(r.name).toLowerCase());
      if (score >= 0.55) out.push({
        targetTable: "carriers",
        targetId: r.id,
        targetLabel: r.name,
        score: 0.5 + score * 0.4, // map 0.55..1 → 0.72..0.9
        signal: `fuzzy_name:${score.toFixed(2)}`,
      });
    });
  }

  return rankUnique(out);
}

async function resolveCustomer(orgId: string, payload: RateConExtraction): Promise<ScoredCandidate[]> {
  const broker = (payload.brokerName.value ?? "").trim();
  if (broker.length < 3) return [];
  const out: ScoredCandidate[] = [];
  const cleaned = stripCorpSuffixes(broker).toLowerCase();

  // Companies (CRM accounts) — preferred targets for follow-up actions.
  const companyRows = await db.select().from(companies).where(and(
    eq(companies.organizationId, orgId),
    ilike(companies.name, `%${broker}%`),
  )).limit(15);
  companyRows.forEach((r) => {
    const sim = nameSimilarity(cleaned, stripCorpSuffixes(r.name).toLowerCase());
    if (sim >= 0.5) out.push({
      targetTable: "companies",
      targetId: r.id,
      targetLabel: r.name,
      score: sim >= 0.95 ? 0.97 : 0.6 + sim * 0.3,
      signal: sim >= 0.95 ? "name_exact" : `fuzzy_name:${sim.toFixed(2)}`,
    });
  });

  // Quote-customers fallback — broker exists in quote pipeline but not yet
  // promoted to an account.
  if (out.length === 0) {
    const qcRows = await db.select().from(quoteCustomers).where(and(
      eq(quoteCustomers.organizationId, orgId),
      ilike(quoteCustomers.name, `%${broker}%`),
    )).limit(10);
    qcRows.forEach((r) => {
      const sim = nameSimilarity(cleaned, stripCorpSuffixes(r.name).toLowerCase());
      if (sim >= 0.6) out.push({
        targetTable: "quote_customers",
        targetId: r.id,
        targetLabel: r.name,
        score: 0.55 + sim * 0.35,
        signal: `quote_customer_fuzzy:${sim.toFixed(2)}`,
      });
    });
  }

  return rankUnique(out);
}

async function resolveLane(orgId: string, payload: RateConExtraction): Promise<ScoredCandidate[]> {
  const oCity = (payload.originCity.value ?? "").trim();
  const oState = (payload.originState.value ?? "").trim();
  const oZip = (payload.originZip.value ?? "").trim();
  const dCity = (payload.destinationCity.value ?? "").trim();
  const dState = (payload.destinationState.value ?? "").trim();
  const dZip = (payload.destinationZip.value ?? "").trim();
  if (!oState && !oZip) return [];
  if (!dState && !dZip) return [];

  const out: ScoredCandidate[] = [];

  // 1. Try recurring_lanes — these are the highest-quality lane records.
  if (oCity && oState && dCity && dState) {
    const rows = await db.select().from(recurringLanes).where(and(
      eq(recurringLanes.orgId, orgId),
      ilike(recurringLanes.origin, `%${oCity}%`),
      ilike(recurringLanes.destination, `%${dCity}%`),
    )).limit(8);
    rows.forEach((r) => {
      const oMatch = (r.originState ?? "").toUpperCase() === oState.toUpperCase();
      const dMatch = (r.destinationState ?? "").toUpperCase() === dState.toUpperCase();
      if (oMatch && dMatch) out.push({
        targetTable: "recurring_lanes",
        targetId: r.id,
        targetLabel: `${r.origin} → ${r.destination}${r.equipmentType ? ` (${r.equipmentType})` : ""}`,
        score: 0.92,
        signal: "recurring_lane_city_state_match",
      });
    });
  }

  // 2. ZIP3 fallback in load_fact — derive a lane shape from realised loads.
  if (out.length === 0 && oZip.length >= 3 && dZip.length >= 3) {
    const oZip3 = oZip.slice(0, 3);
    const dZip3 = dZip.slice(0, 3);
    type Zip3Row = {
      origin_zip: string | null;
      origin_city: string | null;
      origin_state: string | null;
      destination_zip: string | null;
      destination_city: string | null;
      destination_state: string | null;
      load_count: string;
    };
    const rows = await db.execute<Zip3Row>(sql`
      SELECT origin_zip, origin_city, origin_state,
             destination_zip, destination_city, destination_state,
             COUNT(*)::text AS load_count
      FROM ${loadFact}
      WHERE org_id = ${orgId}
        AND substring(origin_zip from 1 for 3) = ${oZip3}
        AND substring(destination_zip from 1 for 3) = ${dZip3}
      GROUP BY origin_zip, origin_city, origin_state, destination_zip, destination_city, destination_state
      ORDER BY load_count DESC
      LIMIT 5
    `).catch((): { rows: Zip3Row[] } => ({ rows: [] }));
    rows.rows.forEach((r) => {
      out.push({
        targetTable: "load_fact_zip3",
        targetId: `${oZip3}-${dZip3}`,
        targetLabel: `${r.origin_city ?? oZip3} ${r.origin_state ?? ""} → ${r.destination_city ?? dZip3} ${r.destination_state ?? ""} (${r.load_count} loads)`,
        score: 0.7,
        signal: `zip3_${oZip3}_${dZip3}`,
      });
    });
  }

  return rankUnique(out);
}

async function resolveLoad(orgId: string, payload: RateConExtraction): Promise<ScoredCandidate[]> {
  const candidates = [
    payload.loadReference.value,
    payload.proNumber.value,
    payload.orderNumber.value,
  ].map((v) => (v ?? "").trim()).filter(Boolean);
  if (candidates.length === 0) return [];
  const out: ScoredCandidate[] = [];
  const rows = await db.select().from(loadFact).where(and(
    eq(loadFact.orgId, orgId),
    inArray(loadFact.orderId, candidates),
  )).limit(5);
  rows.forEach((r) => {
    out.push({
      targetTable: "load_fact",
      targetId: r.id,
      targetLabel: `${r.orderId} — ${r.customerName ?? "?"} (${r.bucket})`,
      score: 0.95,
      signal: `order_id_exact:${r.orderId}`,
    });
  });
  return rankUnique(out);
}

async function resolveQuote(
  orgId: string,
  payload: RateConExtraction,
  customer: ScoredCandidate | null,
): Promise<ScoredCandidate[]> {
  if (!customer || customer.targetTable !== "quote_customers") {
    // Quote opportunities are keyed by quote_customer_id — if the resolved
    // customer is a CRM company we can't link directly without a join. Fall
    // back to lane-only matching scoped to recent quotes.
  }

  const oState = (payload.originState.value ?? "").trim().toUpperCase();
  const dState = (payload.destinationState.value ?? "").trim().toUpperCase();
  if (!oState || !dState) return [];

  const since = new Date(Date.now() - QUOTE_LOOKBACK_DAYS * 86400000);
  const conds = [
    eq(quoteOpportunities.organizationId, orgId),
    eq(quoteOpportunities.originState, oState),
    eq(quoteOpportunities.destState, dState),
    gte(quoteOpportunities.requestDate, since),
  ];
  if (customer && customer.targetTable === "quote_customers") {
    conds.push(eq(quoteOpportunities.customerId, customer.targetId));
  }
  const rows = await db.select().from(quoteOpportunities).where(and(...conds))
    .orderBy(desc(quoteOpportunities.requestDate))
    .limit(8);

  const out: ScoredCandidate[] = [];
  rows.forEach((r) => {
    let score = 0.65;
    let signalParts: string[] = [`lane:${oState}-${dState}`];
    // Bump if customer matched explicitly.
    if (customer && customer.targetTable === "quote_customers" && r.customerId === customer.targetId) {
      score += 0.15;
      signalParts.push("customer_match");
    }
    // Bump if won — those matter most for pricing inconsistency.
    if (r.outcomeStatus === "won") {
      score += 0.05;
      signalParts.push("won");
    }
    out.push({
      targetTable: "quote_opportunities",
      targetId: r.id,
      targetLabel: `${r.originCity}, ${r.originState} → ${r.destCity}, ${r.destState} (${r.outcomeStatus}, ${r.requestDate.toISOString().slice(0, 10)})`,
      score: Math.min(score, 0.95),
      signal: signalParts.join("+"),
    });
  });
  return rankUnique(out);
}

async function resolveOpportunity(
  orgId: string,
  payload: RateConExtraction,
  customer: ScoredCandidate | null,
): Promise<ScoredCandidate[]> {
  if (!customer || customer.targetTable !== "companies") return [];
  const oCity = (payload.originCity.value ?? "").trim();
  const dCity = (payload.destinationCity.value ?? "").trim();
  if (!oCity || !dCity) return [];

  const rows = await db.select().from(freightOpportunities).where(and(
    eq(freightOpportunities.orgId, orgId),
    eq(freightOpportunities.companyId, customer.targetId),
    ilike(freightOpportunities.origin, `%${oCity}%`),
    ilike(freightOpportunities.destination, `%${dCity}%`),
  )).limit(8);

  const out: ScoredCandidate[] = [];
  rows.forEach((r) => {
    const isClosed = ["awarded", "lost", "cancelled", "closed"].includes(r.status);
    out.push({
      targetTable: "freight_opportunities",
      targetId: r.id,
      targetLabel: `${r.origin} → ${r.destination} (${r.status})`,
      score: isClosed ? 0.6 : 0.85,
      signal: `company_match+lane_city`,
    });
  });
  return rankUnique(out);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function rankUnique(cands: ScoredCandidate[]): ScoredCandidate[] {
  // Dedup by (table, id), keep highest score.
  const map = new Map<string, ScoredCandidate>();
  for (const c of cands) {
    const key = `${c.targetTable}::${c.targetId}`;
    const prior = map.get(key);
    if (!prior || c.score > prior.score) map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

export function digitsOnly(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/\D+/g, "");
}

const CORP_SUFFIX_RE = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|holdings|group|trucking|transportation|transport|freight|logistics|logistic|carriers?|express|lines?|shipping|distribution)\b\.?/gi;

export function stripCorpSuffixes(name: string): string {
  return name.replace(CORP_SUFFIX_RE, "").replace(/[^a-z0-9 ]+/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Cheap string similarity 0..1. Uses bigram overlap (Sørensen-Dice). Good
 * enough to catch "ACH FOODS LLC" vs "ACH Foods, Inc." and reject "ACH
 * Foods" vs "Allied Transport". Avoids pulling a heavy fuzzy lib for
 * what is a small intra-org matching problem.
 */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigramsOf = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    const cleaned = s.toLowerCase().replace(/\s+/g, "");
    if (cleaned.length < 2) {
      m.set(cleaned, 1);
      return m;
    }
    for (let i = 0; i < cleaned.length - 1; i++) {
      const bg = cleaned.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const aBg = bigramsOf(a);
  const bBg = bigramsOf(b);
  let intersection = 0;
  for (const [bg, ca] of aBg) {
    const cb = bBg.get(bg);
    if (cb) intersection += Math.min(ca, cb);
  }
  const aSize = [...aBg.values()].reduce((s, n) => s + n, 0);
  const bSize = [...bBg.values()].reduce((s, n) => s + n, 0);
  if (aSize + bSize === 0) return 0;
  return (2 * intersection) / (aSize + bSize);
}
