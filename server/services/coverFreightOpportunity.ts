import type { FreightOpportunity, User } from "@shared/schema";
import { storage } from "../storage";
import { upsertLoadFact } from "../carrierIntelligenceService";

export interface CoverPayload {
  carrierId?: string | null;
  carrierName?: string | null;
  paidRate: number;
  customerRate: number;
  notes?: string | null;
}

export interface CoverResult {
  ok: true;
  opportunity: FreightOpportunity;
  loadFact: { inserted: boolean; updated: boolean; loadFactId?: string } | null;
}

export interface CoverError {
  ok: false;
  status: number;
  error: string;
}

export type CoverOutcome = CoverResult | CoverError;

const MANAGER_ROLES = new Set([
  "admin",
  "director",
  "national_account_manager",
  "sales_director",
  "logistics_manager",
]);

export function canCoverOpportunity(opp: FreightOpportunity, rep: User): boolean {
  const isOwner = opp.ownerUserId === rep.id || opp.delegatedToUserId === rep.id;
  return isOwner || MANAGER_ROLES.has(rep.role);
}

export async function coverFreightOpportunity(args: {
  org: string;
  rep: User;
  opp: FreightOpportunity;
  payload: CoverPayload;
}): Promise<CoverOutcome> {
  const { org, rep, opp, payload } = args;

  if (!canCoverOpportunity(opp, rep)) {
    return { ok: false, status: 403, error: "Only the owner, delegate, or a manager can mark covered" };
  }
  if (opp.status === "covered") {
    return { ok: false, status: 400, error: "Opportunity is already covered" };
  }
  if (!(payload.paidRate > 0) || !(payload.customerRate > 0)) {
    return { ok: false, status: 400, error: "paidRate and customerRate must be positive" };
  }

  let carrierName: string | null = payload.carrierName?.trim() || null;
  if (!carrierName && payload.carrierId) {
    const c = await storage.getCarrier(payload.carrierId);
    if (c && c.organizationId !== org) {
      return { ok: false, status: 403, error: "Carrier does not belong to your organization" };
    }
    carrierName = c?.name ?? null;
  }
  if (!carrierName) {
    return { ok: false, status: 400, error: "Could not resolve carrier name" };
  }

  const company = await storage.getCompany(opp.companyId);
  const customerName = company?.name ?? null;

  const loadCount = Math.max(1, opp.loadCount ?? 1);
  const revenue = payload.customerRate * loadCount;
  const cost = payload.paidRate * loadCount;
  const margin = revenue - cost;
  const marginPct = revenue > 0 ? margin / revenue : 0;

  const updated = await storage.updateFreightOpportunity(
    org,
    opp.id,
    { status: "covered", awaitingApprovalSince: null },
    { allowCoveredTransition: true },
  );

  await storage.appendFreightOpportunityAudit({
    opportunityId: opp.id,
    eventType: "status_changed",
    actorUserId: rep.id,
    payload: {
      kind: "covered",
      carrierId: payload.carrierId ?? null,
      carrierName,
      paidRate: payload.paidRate,
      customerRate: payload.customerRate,
      revenue,
      cost,
      margin,
      loadCount,
      notes: payload.notes ?? null,
    },
  });

  const month = (opp.pickupWindowStart || new Date().toISOString()).slice(0, 7);
  const sourceRefOrderId = (() => {
    const ref = opp.sourceRef as { orderId?: unknown } | null | undefined;
    const candidate = ref?.orderId;
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith("freight_opp:")) return null;
    return trimmed;
  })();
  const loadFactOrderId = sourceRefOrderId ?? `freight_opp:${opp.id}`;

  if (sourceRefOrderId) {
    const { db } = await import("../storage");
    const { loadFact } = await import("@shared/schema");
    const { and, eq, sql: sqlOp } = await import("drizzle-orm");
    try {
      await db.update(loadFact)
        .set({ orderId: sourceRefOrderId, lastChangedAt: new Date() })
        .where(and(
          eq(loadFact.orgId, org),
          eq(loadFact.orderId, `freight_opp:${opp.id}`),
          sqlOp`NOT EXISTS (
            SELECT 1 FROM ${loadFact} lf2
             WHERE lf2.org_id = ${org}
               AND lf2.order_id = ${sourceRefOrderId}
          )`,
        ));
    } catch (e) {
      console.warn(
        `[freight-opps] cover synthetic→real orderId rename failed for opp ${opp.id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  let loadFactEmit: { inserted: boolean; updated: boolean; loadFactId?: string } | null = null;
  try {
    const out = await upsertLoadFact({
      orgId: org,
      orderId: loadFactOrderId,
      companyId: opp.companyId,
      customerName,
      carrierName,
      carrierPayeeCode: null,
      originCity: opp.origin,
      originState: opp.originState ?? null,
      originZip: null,
      destinationCity: opp.destination,
      destinationState: opp.destinationState ?? null,
      destinationZip: null,
      accountManager: rep.name ?? rep.email ?? null,
      dispatcher: null,
      equipmentType: opp.equipmentType ?? null,
      pickupDate: opp.pickupWindowStart ?? null,
      deliveryDate: null,
      pickupApptStart: null,
      pickupApptEnd: null,
      deliveryApptStart: null,
      deliveryApptEnd: null,
      arrivedAtPickup: null,
      arrivedAtDelivery: null,
      totalStops: null,
      totalMiles: null,
      month,
      moveStatus: "covered",
      bucket: "realized",
      revenue: revenue.toFixed(2),
      cost: cost.toFixed(2),
      margin: margin.toFixed(2),
      marginPct: marginPct.toFixed(4),
      loadCount,
      rawRow: { source: "freight_opp_coverage", oppId: opp.id, repUserId: rep.id },
      sourceFileName: null,
      sourceKind: "freight_opp_coverage",
    });
    loadFactEmit = { inserted: out.inserted, updated: out.updated, loadFactId: out.loadFactId };
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "load_fact_emitted",
      actorUserId: rep.id,
      payload: {
        loadFactId: out.loadFactId,
        inserted: out.inserted,
        updated: out.updated,
        changedFields: out.changedFields,
      },
    });
  } catch (emitErr) {
    console.error("[freight-opps] cover load_fact emit failed:", emitErr);
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "load_fact_emit_failed",
      actorUserId: rep.id,
      payload: { error: emitErr instanceof Error ? emitErr.message : String(emitErr) },
    });
  }

  return { ok: true, opportunity: updated, loadFact: loadFactEmit };
}
