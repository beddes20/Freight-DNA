import type { FreightOpportunity, User } from "@shared/schema";
import { storage } from "../storage";
import { upsertLoadFact } from "../carrierIntelligenceService";
import { recordCarrierLaneOutcome } from "./carrierLaneOutcomes";
import { laneSig } from "../laneCrossLinkService";
import {
  applyCoverCaptureLoops,
  type CoverCaptureLoopsResult,
  type CoverLoopOptions,
} from "./coverCaptureLoops";

export interface CoverPayload {
  carrierId?: string | null;
  carrierName?: string | null;
  paidRate: number;
  customerRate: number;
  notes?: string | null;
  /**
   * Per-cover opt-out flags for the three downstream capture loops
   * (bench, lane rate band, recurring-lane suggestion). Default to true
   * for each loop when omitted, matching the previous behaviour for any
   * caller that hasn't been updated.
   */
  loops?: Partial<CoverLoopOptions>;
}

export interface CoverResult {
  ok: true;
  opportunity: FreightOpportunity;
  loadFact: { inserted: boolean; updated: boolean; loadFactId?: string } | null;
  loops: CoverCaptureLoopsResult | null;
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
    if (c && c.orgId !== org) {
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
  if (!updated) {
    return { ok: false, status: 500, error: "Failed to update opportunity status" };
  }

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

  // Task #637 — bump cover_count for the (carrier, lane) prior so the
  // ranker can read "carrier X has 2 covers on this lane" on its next call.
  // Carrier-id-less covers (rep typed in a brand-new carrier name) are
  // skipped — the prior table is keyed on carriers.id by design.
  if (payload.carrierId) {
    await recordCarrierLaneOutcome({
      orgId: org,
      carrierId: payload.carrierId,
      laneSignature: laneSig(
        opp.origin,
        opp.originState,
        opp.destination,
        opp.destinationState,
        opp.equipmentType,
      ),
      origin: opp.origin,
      originState: opp.originState,
      destination: opp.destination,
      destinationState: opp.destinationState,
      equipmentType: opp.equipmentType,
      event: "cover",
      // (opportunityId, carrierId) is unique per cover capture — replays
      // of the cover route from the same UI / API caller are no-ops.
      eventKey: `cover:${opp.id}:${payload.carrierId}`,
    });
  }

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
      accountManager: rep.name ?? rep.username ?? null,
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

  // Capture loops — bench, rate band, recurring-lane suggestion. Each
  // loop honours its opt-out flag from `payload.loops` and never throws;
  // failures are absorbed so the cover write is never blocked.
  let loopsResult: CoverCaptureLoopsResult | null = null;
  try {
    loopsResult = await applyCoverCaptureLoops(
      {
        org,
        opp,
        carrierId: payload.carrierId ?? null,
        carrierName,
        paidRate: payload.paidRate,
        customerRate: payload.customerRate,
        options: payload.loops,
      },
      { storage },
    );
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "cover_loops_applied",
      actorUserId: rep.id,
      payload: {
        bench: loopsResult.bench,
        rateBand: loopsResult.rateBand,
        recurringLaneSuggestion: loopsResult.recurringLaneSuggestion,
      },
    });
  } catch (loopErr) {
    console.warn("[freight-opps] cover capture loops failed:", loopErr);
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "cover_loops_failed",
      actorUserId: rep.id,
      payload: { error: loopErr instanceof Error ? loopErr.message : String(loopErr) },
    });
  }

  return { ok: true, opportunity: updated, loadFact: loadFactEmit, loops: loopsResult };
}
