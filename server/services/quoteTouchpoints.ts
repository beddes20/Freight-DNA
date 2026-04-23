import { and, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  companies, quoteCustomers, quoteOpportunities, quoteReps,
  type QuoteOpportunity,
} from "@shared/schema";

export type QuoteTouchpointType = "quote_sent" | "quote_won" | "quote_lost";

const EVENT_TYPE_TO_TOUCHPOINT: Record<string, QuoteTouchpointType> = {
  quoted: "quote_sent",
  won: "quote_won",
  tms_won: "quote_won",
  lost: "quote_lost",
  tms_lost: "quote_lost",
};

const TOUCHPOINT_LABELS: Record<QuoteTouchpointType, string> = {
  quote_sent: "Quote sent",
  quote_won: "Quote won",
  quote_lost: "Quote lost",
};

function fmtMoney(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function buildSummary(type: QuoteTouchpointType, opp: QuoteOpportunity): string {
  const lane = `${opp.originCity}, ${opp.originState} → ${opp.destCity}, ${opp.destState}`;
  const parts = [`${TOUCHPOINT_LABELS[type]} — ${lane}`, opp.equipment];
  const price = type === "quote_won"
    ? fmtMoney(opp.carrierPaid) ?? fmtMoney(opp.quotedAmount)
    : fmtMoney(opp.quotedAmount);
  if (price) parts.push(price);
  return parts.filter(Boolean).join(" · ");
}

/**
 * Auto-log a quote event as a touchpoint on the matched customer's company
 * timeline. Idempotent on `eventId` via `touchpoints.external_id`.
 *
 * Returns silently if:
 *  - The event type doesn't map to a customer-facing touchpoint.
 *  - No company can be matched by name within the org.
 *  - No real user can be resolved as the logger.
 *  - The event already has a touchpoint logged (dedupe).
 */
export async function logQuoteTouchpointFromEvent(input: {
  orgId: string;
  oppId: string;
  eventId: string;
  eventType: string;
  occurredAt?: Date | null;
  /** Fallback user id to record as logger when no rep mapping exists. */
  fallbackUserId?: string | null;
}): Promise<void> {
  const tpType = EVENT_TYPE_TO_TOUCHPOINT[input.eventType];
  if (!tpType) return;

  try {
    const existing = await storage.getTouchpointByExternalId(input.eventId);
    if (existing) return;

    const [opp] = await db.select().from(quoteOpportunities)
      .where(and(eq(quoteOpportunities.organizationId, input.orgId), eq(quoteOpportunities.id, input.oppId)))
      .limit(1);
    if (!opp) return;

    const [cust] = await db.select().from(quoteCustomers)
      .where(and(eq(quoteCustomers.organizationId, input.orgId), eq(quoteCustomers.id, opp.customerId)))
      .limit(1);
    if (!cust) return;

    // Match company by case-insensitive name within the same org.
    const [co] = await db.select().from(companies)
      .where(and(
        eq(companies.organizationId, input.orgId),
        sql`lower(${companies.name}) = lower(${cust.name})`,
      ))
      .limit(1);
    if (!co) return;

    // Resolve the logger user: prefer rep's mapped user, then company.assignedTo,
    // then explicit fallback. Touchpoints require a real users.id FK.
    let loggedById: string | null = null;
    if (opp.repId) {
      const [rep] = await db.select().from(quoteReps).where(eq(quoteReps.id, opp.repId)).limit(1);
      if (rep?.userId) loggedById = rep.userId;
    }
    if (!loggedById && co.assignedTo) loggedById = co.assignedTo;
    if (!loggedById && input.fallbackUserId) loggedById = input.fallbackUserId;
    if (!loggedById) return;

    const when = input.occurredAt ?? new Date();
    await storage.createTouchpointWithDefaults({
      companyId: co.id,
      loggedById,
      type: tpType,
      notes: buildSummary(tpType, opp),
      date: when.toISOString().split("T")[0],
      createdAt: when.toISOString(),
      externalId: input.eventId,
    });
  } catch (err) {
    // Auto-logging must never break the underlying quote write path.
    console.error("[quote-touchpoints] failed to log touchpoint", {
      eventId: input.eventId,
      eventType: input.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
