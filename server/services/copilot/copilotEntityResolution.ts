/**
 * Copilot Entity Resolution — Task #926 step 3.
 *
 * Maps extracted-document fields to existing CRM rows using the resolvers
 * already in the codebase:
 *   - customer name → companies (exact, then fuzzy)
 *   - MC# / DOT → carriers
 *   - origin/dest+equipment → recurring_lanes (state-pair fuzzy)
 *   - explicit `uploadContext.{entityType,entityId}` overrides everything
 *     (the rep already pinned the doc when they dropped it).
 *
 * Returns a `ResolvedEntities` envelope with confidence + path. Ambiguous
 * matches surface as `ambiguities[]` for the UI to render a "confirm match"
 * affordance — never silently picks one.
 */
import { db } from "../../storage";
import { and, eq, ilike, sql } from "drizzle-orm";
import {
  companies,
  carriers,
  recurringLanes,
  type ResolvedEntities,
} from "@shared/schema";

interface ResolveArgs {
  organizationId: string;
  classLabel: string;
  payload: unknown;
  uploadContext: Record<string, unknown> | null;
}

const STATE_RE = /\b([A-Z]{2})\b/;

function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fieldValue(field: unknown): string | null {
  if (field == null) return null;
  if (typeof field === "string" || typeof field === "number") return String(field).trim() || null;
  if (typeof field === "object" && "value" in (field as Record<string, unknown>)) {
    const v = (field as { value: unknown }).value;
    return v == null ? null : String(v).trim() || null;
  }
  return null;
}

function laneKeyFrom(origin: string | null, dest: string | null, equipment: string | null): string | null {
  if (!origin && !dest) return null;
  const oS = origin?.match(STATE_RE)?.[1] ?? "";
  const dS = dest?.match(STATE_RE)?.[1] ?? "";
  const eq = (equipment ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!oS || !dS) return null;
  return `${oS}-${dS}-${eq || "ANY"}`;
}

async function resolveCustomer(
  organizationId: string,
  customerName: string | null,
  uploadContext: Record<string, unknown> | null,
): Promise<{ id: string | null; name: string | null; confidence: ResolvedEntities["customerConfidence"]; path: string[]; candidates: Array<{ id: string; label: string }> }> {
  // 1. Pinned from upload context.
  if (uploadContext && typeof uploadContext === "object") {
    const pinned = uploadContext.companyId ?? (uploadContext.entityType === "company" ? uploadContext.entityId : null);
    if (typeof pinned === "string" && pinned) {
      const [row] = await db.select().from(companies).where(and(eq(companies.id, pinned), eq(companies.organizationId, organizationId))).limit(1);
      if (row) return { id: row.id, name: row.name, confidence: "high", path: ["upload_context_pinned"], candidates: [] };
    }
  }
  if (!customerName) return { id: null, name: null, confidence: "none", path: [], candidates: [] };

  const norm = normalizeName(customerName);
  if (!norm) return { id: null, name: null, confidence: "none", path: [], candidates: [] };

  // 2. Exact (case-insensitive).
  const exact = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.organizationId, organizationId), ilike(companies.name, customerName)))
    .limit(5);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, confidence: "high", path: ["exact_company_name"], candidates: [] };
  if (exact.length > 1) {
    return { id: null, name: customerName, confidence: "ambiguous", path: ["exact_company_name_multiple"], candidates: exact.map((c) => ({ id: c.id, label: c.name })) };
  }

  // 3. Fuzzy — leading prefix.
  const prefix = customerName.split(/\s+/)[0];
  if (prefix && prefix.length >= 3) {
    const fuzzy = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), ilike(companies.name, `${prefix}%`)))
      .limit(10);
    const scored = fuzzy
      .map((c) => ({ ...c, score: 1 - levenshteinNorm(normalizeName(c.name), norm) }))
      .filter((c) => c.score >= 0.65)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0].score >= 0.85 && scored[0].score - scored[1].score >= 0.15)) {
      return { id: scored[0].id, name: scored[0].name, confidence: "medium", path: ["fuzzy_company_name"], candidates: [] };
    }
    if (scored.length > 1) {
      return {
        id: null,
        name: customerName,
        confidence: "ambiguous",
        path: ["fuzzy_company_name_multiple"],
        candidates: scored.slice(0, 5).map((c) => ({ id: c.id, label: c.name })),
      };
    }
  }
  return { id: null, name: customerName, confidence: "none", path: ["no_match"], candidates: [] };
}

async function resolveCarriersByName(organizationId: string, names: string[]): Promise<Array<{ name: string; id: string | null }>> {
  if (!names.length) return [];
  const out: Array<{ name: string; id: string | null }> = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const exact = await db
      .select({ id: carriers.id })
      .from(carriers)
      .where(and(eq(carriers.orgId, organizationId), ilike(carriers.name, trimmed)))
      .limit(1);
    out.push({ name: trimmed, id: exact[0]?.id ?? null });
  }
  return out;
}

async function resolveCarrierByMc(organizationId: string, mc: string | null): Promise<string | null> {
  if (!mc) return null;
  const num = mc.replace(/[^\d]/g, "");
  if (!num) return null;
  const [row] = await db
    .select({ id: carriers.id })
    .from(carriers)
    .where(and(eq(carriers.orgId, organizationId), sql`${carriers.mcDot} ILIKE ${`%${num}%`}`))
    .limit(1);
  return row?.id ?? null;
}

async function resolveLane(
  organizationId: string,
  origin: string | null,
  destination: string | null,
  equipment: string | null,
  customerId: string | null,
): Promise<{ key: string | null; recurringLaneIds: string[] }> {
  const key = laneKeyFrom(origin, destination, equipment);
  if (!origin || !destination) return { key, recurringLaneIds: [] };
  const oS = origin.match(STATE_RE)?.[1];
  const dS = destination.match(STATE_RE)?.[1];
  if (!oS || !dS) return { key, recurringLaneIds: [] };

  const where = customerId
    ? and(
        eq(recurringLanes.orgId, organizationId),
        eq(recurringLanes.companyId, customerId),
        eq(recurringLanes.originState, oS),
        eq(recurringLanes.destinationState, dS),
      )
    : and(
        eq(recurringLanes.orgId, organizationId),
        eq(recurringLanes.originState, oS),
        eq(recurringLanes.destinationState, dS),
      );
  const rows = await db.select({ id: recurringLanes.id }).from(recurringLanes).where(where).limit(5);
  return { key, recurringLaneIds: rows.map((r) => r.id) };
}

// Cheap normalized levenshtein for fuzzy company match.
function levenshteinNorm(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al || !bl) return 1;
  const max = Math.max(al, bl);
  const v0 = new Array(bl + 1).fill(0);
  const v1 = new Array(bl + 1).fill(0);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl] / max;
}

export async function resolveEntities(args: ResolveArgs): Promise<ResolvedEntities> {
  const { organizationId, classLabel, payload, uploadContext } = args;
  const p = payload as Record<string, unknown>;

  // Common fields.
  const customerName = fieldValue(p?.customer);
  const mcNumber = fieldValue(p?.mc_number);
  const origin = fieldValue(p?.origin);
  const destination = fieldValue(p?.destination);
  const equipment = fieldValue(p?.equipment);

  const cust = await resolveCustomer(organizationId, customerName, uploadContext);
  const carrierByMc = await resolveCarrierByMc(organizationId, mcNumber);

  // Class-specific multi-row sweeps.
  const laneKeys: string[] = [];
  const recurringLaneIds = new Set<string>();
  const carriersByName: Array<{ name: string; id: string | null }> = [];
  const ambiguities: ResolvedEntities["ambiguities"] = [];

  if (cust.confidence === "ambiguous" && cust.candidates.length) {
    ambiguities.push({ field: "customer", candidates: cust.candidates });
  }

  if (classLabel === "rfp_bid_sheet" && Array.isArray((p as { lanes?: unknown }).lanes)) {
    for (const lane of (p as { lanes: Array<Record<string, unknown>> }).lanes) {
      const oCity = fieldValue(lane.origin_city);
      const oState = fieldValue(lane.origin_state);
      const dCity = fieldValue(lane.destination_city);
      const dState = fieldValue(lane.destination_state);
      const eq = fieldValue(lane.equipment);
      const oFull = oCity && oState ? `${oCity}, ${oState}` : oCity ?? oState;
      const dFull = dCity && dState ? `${dCity}, ${dState}` : dCity ?? dState;
      const r = await resolveLane(organizationId, oFull, dFull, eq, cust.id);
      if (r.key) laneKeys.push(r.key);
      r.recurringLaneIds.forEach((id) => recurringLaneIds.add(id));
    }
  } else if (classLabel === "routing_guide" && Array.isArray((p as { entries?: unknown }).entries)) {
    for (const entry of (p as { entries: Array<Record<string, unknown>> }).entries) {
      const o = fieldValue(entry.origin);
      const d = fieldValue(entry.destination);
      const eq = fieldValue(entry.equipment);
      const r = await resolveLane(organizationId, o, d, eq, cust.id);
      if (r.key) laneKeys.push(r.key);
      r.recurringLaneIds.forEach((id) => recurringLaneIds.add(id));
      const names = [
        fieldValue(entry.primary_carrier),
        fieldValue(entry.backup_carrier),
        fieldValue(entry.tertiary_carrier),
      ].filter((x): x is string => Boolean(x));
      const resolved = await resolveCarriersByName(organizationId, names);
      carriersByName.push(...resolved);
    }
  } else {
    // Single-lane docs (rate_con, bol, contract).
    const r = await resolveLane(organizationId, origin, destination, equipment, cust.id);
    if (r.key) laneKeys.push(r.key);
    r.recurringLaneIds.forEach((id) => recurringLaneIds.add(id));
  }

  const carrierIds = new Set<string>();
  if (carrierByMc) carrierIds.add(carrierByMc);
  for (const c of carriersByName) if (c.id) carrierIds.add(c.id);

  return {
    customerId: cust.id,
    customerName: cust.name ?? customerName ?? null,
    customerConfidence: cust.confidence,
    customerPath: cust.path,
    carrierIds: Array.from(carrierIds),
    carriersByName,
    laneKeys: Array.from(new Set(laneKeys)),
    recurringLaneIds: Array.from(recurringLaneIds),
    rfpId: null,
    awardId: null,
    opportunityId: null,
    freightId: null,
    ambiguities,
  };
}
