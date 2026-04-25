/**
 * Task #637 — Carrier × lane outcome counter helpers.
 *
 * Single writer for the `carrier_lane_outcomes` table. Every outreach event
 * (sent / open / reply / yes / quote / cover / loss) bumps the matching
 * counter for (orgId, carrierId, laneSignature) using an atomic
 * INSERT ... ON CONFLICT DO UPDATE so concurrent senders never lose
 * counts. The reader is `getCarrierLaneOutcomesForLane()`, which the carrier
 * ranker calls once per rank invocation to read priors for every catalog
 * carrier on the lane.
 *
 * Idempotence: callers own dedup. The wired call sites (outbound send,
 * reply classifier, cover capture, manual-outcome route) all run at most
 * once per logical event under normal flow; the helper does not maintain
 * its own event-id ledger to keep the hot path cheap.
 */

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { carrierLaneOutcomes, type CarrierLaneOutcome } from "@shared/schema";
import { laneSig } from "../laneCrossLinkService";

export type CarrierLaneOutcomeEventType =
  | "sent"
  | "open"
  | "reply"
  | "yes"
  | "quote"
  | "cover"
  | "loss";

export interface RecordCarrierLaneOutcomeInput {
  orgId: string;
  carrierId: string;
  /** Pre-computed signature, or omit to derive from lane parts below. */
  laneSignature?: string;
  origin?: string | null;
  originState?: string | null;
  destination?: string | null;
  destinationState?: string | null;
  equipmentType?: string | null;
  event: CarrierLaneOutcomeEventType;
  /** Optional event timestamp; defaults to NOW() server-side. */
  eventAt?: Date;
}

const EVENT_COLUMN: Record<CarrierLaneOutcomeEventType, string> = {
  sent: "sent_count",
  open: "open_count",
  reply: "reply_count",
  yes: "yes_count",
  quote: "quote_count",
  cover: "cover_count",
  loss: "loss_count",
};

/**
 * Atomically increment the per-event counter for (orgId, carrierId, laneSig).
 * Inserts a fresh row when none exists, otherwise increments the matching
 * counter and rolls last_event_at forward (never backward — safer under
 * out-of-order replays from the backfill script).
 *
 * Returns silently on missing required fields so a wiring miss never throws
 * on the hot send path; logs a warning instead.
 */
export async function recordCarrierLaneOutcome(
  input: RecordCarrierLaneOutcomeInput,
): Promise<void> {
  const { orgId, carrierId, event } = input;
  if (!orgId || !carrierId) {
    console.warn("[carrier-lane-outcomes] missing orgId/carrierId; event dropped:", { event });
    return;
  }
  const signature = input.laneSignature
    ?? laneSig(input.origin, input.originState, input.destination, input.destinationState, input.equipmentType);
  if (!signature || signature === "||||") {
    console.warn("[carrier-lane-outcomes] empty lane signature; event dropped:", { orgId, carrierId, event });
    return;
  }
  const column = EVENT_COLUMN[event];
  if (!column) {
    console.warn("[carrier-lane-outcomes] unknown event type; dropped:", { event });
    return;
  }

  const eventAt = input.eventAt ?? new Date();
  // Build the column-set delta inline. Each event maps to exactly one
  // counter; the rest stay zero on insert and untouched on conflict.
  const counters = {
    sent: event === "sent" ? 1 : 0,
    open: event === "open" ? 1 : 0,
    reply: event === "reply" ? 1 : 0,
    yes: event === "yes" ? 1 : 0,
    quote: event === "quote" ? 1 : 0,
    cover: event === "cover" ? 1 : 0,
    loss: event === "loss" ? 1 : 0,
  };

  try {
    await db.execute(sql`
      INSERT INTO carrier_lane_outcomes (
        org_id, carrier_id, lane_signature,
        origin, origin_state, destination, destination_state, equipment_type,
        sent_count, open_count, reply_count, yes_count, quote_count, cover_count, loss_count,
        first_event_at, last_event_at
      ) VALUES (
        ${orgId}, ${carrierId}, ${signature},
        ${input.origin ?? null}, ${input.originState ?? null}, ${input.destination ?? null},
        ${input.destinationState ?? null}, ${input.equipmentType ?? null},
        ${counters.sent}, ${counters.open}, ${counters.reply}, ${counters.yes},
        ${counters.quote}, ${counters.cover}, ${counters.loss},
        ${eventAt}, ${eventAt}
      )
      ON CONFLICT (org_id, carrier_id, lane_signature) DO UPDATE SET
        sent_count    = carrier_lane_outcomes.sent_count    + EXCLUDED.sent_count,
        open_count    = carrier_lane_outcomes.open_count    + EXCLUDED.open_count,
        reply_count   = carrier_lane_outcomes.reply_count   + EXCLUDED.reply_count,
        yes_count     = carrier_lane_outcomes.yes_count     + EXCLUDED.yes_count,
        quote_count   = carrier_lane_outcomes.quote_count   + EXCLUDED.quote_count,
        cover_count   = carrier_lane_outcomes.cover_count   + EXCLUDED.cover_count,
        loss_count    = carrier_lane_outcomes.loss_count    + EXCLUDED.loss_count,
        last_event_at = GREATEST(carrier_lane_outcomes.last_event_at, EXCLUDED.last_event_at)
    `);
  } catch (err) {
    // Counter writes are informational — never break the calling flow.
    console.warn(
      "[carrier-lane-outcomes] upsert failed (non-fatal):",
      err instanceof Error ? err.message : err,
      { orgId, carrierId, event, signature },
    );
  }
}

/**
 * Bulk read: returns every outcome row for the given (orgId, laneSignature).
 * Keyed by carrierId in the returned Map for O(1) lookup inside the ranker.
 *
 * Defensive against transient pool errors — returns an empty map on failure
 * so the ranker degrades to "no prior" rather than crashing the request.
 */
export async function getCarrierLaneOutcomesForLane(
  orgId: string,
  laneSignature: string,
): Promise<Map<string, CarrierLaneOutcome>> {
  const out = new Map<string, CarrierLaneOutcome>();
  if (!orgId || !laneSignature) return out;
  try {
    const rows = await db.execute(sql<CarrierLaneOutcome>`
      SELECT
        id,
        org_id              AS "orgId",
        carrier_id          AS "carrierId",
        lane_signature      AS "laneSignature",
        origin,
        origin_state        AS "originState",
        destination,
        destination_state   AS "destinationState",
        equipment_type      AS "equipmentType",
        sent_count          AS "sentCount",
        open_count          AS "openCount",
        reply_count         AS "replyCount",
        yes_count           AS "yesCount",
        quote_count         AS "quoteCount",
        cover_count         AS "coverCount",
        loss_count          AS "lossCount",
        first_event_at      AS "firstEventAt",
        last_event_at       AS "lastEventAt"
      FROM carrier_lane_outcomes
      WHERE org_id = ${orgId} AND lane_signature = ${laneSignature}
    `);
    const list = (rows as unknown as { rows?: CarrierLaneOutcome[] }).rows
      ?? (rows as unknown as CarrierLaneOutcome[]);
    for (const r of list ?? []) {
      if (r?.carrierId) out.set(r.carrierId, r);
    }
  } catch (err) {
    console.warn(
      "[carrier-lane-outcomes] read failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/**
 * Plain-language summary of an outcome row, suitable for the "why this
 * carrier" hover popover. Emits the strongest evidence first (covers > yes
 * > replies) and returns null when nothing material is recorded.
 */
export function summarizeCarrierLaneOutcome(row: CarrierLaneOutcome | undefined | null): string | null {
  if (!row) return null;
  const parts: string[] = [];
  if (row.coverCount > 0) parts.push(`${row.coverCount} cover${row.coverCount === 1 ? "" : "s"}`);
  if (row.yesCount > 0)   parts.push(`${row.yesCount} yes`);
  if (row.quoteCount > 0) parts.push(`${row.quoteCount} quote${row.quoteCount === 1 ? "" : "s"}`);
  if (parts.length === 0) {
    if (row.replyCount > 0) parts.push(`${row.replyCount} repl${row.replyCount === 1 ? "y" : "ies"}`);
    else if (row.lossCount > 0) parts.push(`${row.lossCount} prior loss${row.lossCount === 1 ? "" : "es"}`);
    else if (row.sentCount > 0) parts.push(`${row.sentCount} prior touch${row.sentCount === 1 ? "" : "es"} (no reply)`);
  }
  if (parts.length === 0) return null;
  return `Lane history: ${parts.join(" + ")}`;
}
