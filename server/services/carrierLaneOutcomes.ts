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
 * Idempotence: callers may pass an `eventKey` (a stable string identifying
 * the logical source event — e.g. `outreach:<logId>:sent`,
 * `webhook:<notificationId>:reply`, `cover:<opportunityId>:<carrierId>`).
 * The helper inserts that key into `carrier_lane_outcome_event_keys` first
 * with `ON CONFLICT DO NOTHING`; only when the insert produced a new row
 * does the counter upsert run, in the same statement (CTE). Duplicate
 * webhook deliveries, replayed audit rows, and re-runs of the backfill
 * therefore never double-count.
 *
 * Reply-count semantics (intentional design):
 *   The "reply" counter is per-pipeline-event, NOT per unique inbound
 *   message. Each producer (Graph webhook, PAFOE classifier, email_signals
 *   replay) emits its own eventKey namespace (`webhook:*`, `pafoe-reply:*`,
 *   `email-signal:*`), so a single inbound email that traverses both the
 *   webhook and the classifier will bump `reply_count` twice — once per
 *   pipeline. This matches downstream KPI usage where reply_count proxies
 *   "engagement signal volume across our pipelines on this lane," not
 *   "distinct human responses." Cross-source dedupe is intentionally NOT
 *   implemented; any future change to per-message semantics should
 *   normalize the eventKey across producers (e.g. provider message-id) so
 *   the existing dedupe ledger continues to be the single point of truth.
 *
 * Timestamp semantics: `first_event_at = LEAST(existing, incoming)` and
 * `last_event_at = GREATEST(existing, incoming)` so out-of-order or
 * back-dated events maintain correct first/last bookends.
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
  /**
   * Optional stable key identifying this logical source event. When
   * provided, repeat calls with the same key are no-ops (event-level
   * idempotence). Omit only for ad-hoc callers where the upstream source
   * already guarantees one-call-per-event under all retry conditions.
   */
  eventKey?: string;
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
 * counter and updates first/last event bookends with LEAST/GREATEST so
 * out-of-order writes (notably from the backfill script) never corrupt
 * the temporal extents.
 *
 * Returns silently on missing required fields so a wiring miss never throws
 * on the hot send path; logs a warning instead.
 */
export async function recordCarrierLaneOutcome(
  input: RecordCarrierLaneOutcomeInput,
): Promise<void> {
  const { orgId, carrierId, event, eventKey } = input;
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
    if (eventKey) {
      // Atomic dedupe + upsert in one round-trip via CTE. The counter
      // upsert runs only when the dedupe insert produced a fresh row
      // (the EXISTS subselect in the SELECT is empty otherwise, so the
      // INSERT inserts zero rows and short-circuits).
      await db.execute(sql`
        WITH dedupe AS (
          INSERT INTO carrier_lane_outcome_event_keys (org_id, event_key, recorded_at)
          VALUES (${orgId}, ${eventKey}, ${eventAt})
          ON CONFLICT (org_id, event_key) DO NOTHING
          RETURNING 1
        )
        INSERT INTO carrier_lane_outcomes (
          org_id, carrier_id, lane_signature,
          origin, origin_state, destination, destination_state, equipment_type,
          sent_count, open_count, reply_count, yes_count, quote_count, cover_count, loss_count,
          first_event_at, last_event_at
        )
        SELECT
          ${orgId}, ${carrierId}, ${signature},
          ${input.origin ?? null}, ${input.originState ?? null}, ${input.destination ?? null},
          ${input.destinationState ?? null}, ${input.equipmentType ?? null},
          ${counters.sent}, ${counters.open}, ${counters.reply}, ${counters.yes},
          ${counters.quote}, ${counters.cover}, ${counters.loss},
          ${eventAt}, ${eventAt}
        WHERE EXISTS (SELECT 1 FROM dedupe)
        ON CONFLICT (org_id, carrier_id, lane_signature) DO UPDATE SET
          sent_count     = carrier_lane_outcomes.sent_count    + EXCLUDED.sent_count,
          open_count     = carrier_lane_outcomes.open_count    + EXCLUDED.open_count,
          reply_count    = carrier_lane_outcomes.reply_count   + EXCLUDED.reply_count,
          yes_count      = carrier_lane_outcomes.yes_count     + EXCLUDED.yes_count,
          quote_count    = carrier_lane_outcomes.quote_count   + EXCLUDED.quote_count,
          cover_count    = carrier_lane_outcomes.cover_count   + EXCLUDED.cover_count,
          loss_count     = carrier_lane_outcomes.loss_count    + EXCLUDED.loss_count,
          first_event_at = LEAST(carrier_lane_outcomes.first_event_at, EXCLUDED.first_event_at),
          last_event_at  = GREATEST(carrier_lane_outcomes.last_event_at, EXCLUDED.last_event_at)
      `);
    } else {
      // Caller chose not to dedupe (guarantees no-retry upstream).
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
          sent_count     = carrier_lane_outcomes.sent_count    + EXCLUDED.sent_count,
          open_count     = carrier_lane_outcomes.open_count    + EXCLUDED.open_count,
          reply_count    = carrier_lane_outcomes.reply_count   + EXCLUDED.reply_count,
          yes_count      = carrier_lane_outcomes.yes_count     + EXCLUDED.yes_count,
          quote_count    = carrier_lane_outcomes.quote_count   + EXCLUDED.quote_count,
          cover_count    = carrier_lane_outcomes.cover_count   + EXCLUDED.cover_count,
          loss_count     = carrier_lane_outcomes.loss_count    + EXCLUDED.loss_count,
          first_event_at = LEAST(carrier_lane_outcomes.first_event_at, EXCLUDED.first_event_at),
          last_event_at  = GREATEST(carrier_lane_outcomes.last_event_at, EXCLUDED.last_event_at)
      `);
    }
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
    const result = await db.execute<CarrierLaneOutcome>(sql`
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
    const rows: CarrierLaneOutcome[] = result.rows ?? [];
    for (const r of rows) {
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
 * Carrier-ranker prior contribution. Pure function so the ranker stays
 * testable without standing up the entire scoring fixture (carrier hist,
 * region match, equipment affinity, etc.). The thresholds here are the
 * single source of truth — the ranker calls this and applies `delta`
 * to fitScore + pushes `reason` (when non-null) onto its reasons list.
 *
 * Ordering matters: covers dominate (strongest possible signal), then
 * positive engagement (yes/quote), then a lone-loss penalty when the
 * carrier has only declined on this lane and never engaged positively.
 */
export interface CarrierLaneOutcomePrior {
  delta: number;
  reason: string | null;
}
export function carrierLaneOutcomePrior(row: CarrierLaneOutcome | undefined | null): CarrierLaneOutcomePrior {
  if (!row) return { delta: 0, reason: null };
  let delta = 0;
  if (row.coverCount > 0) delta = 15;
  else if (row.yesCount > 0 || row.quoteCount > 0) delta = 6;
  else if (
    row.lossCount > 0
    && row.yesCount === 0
    && row.coverCount === 0
    && row.quoteCount === 0
  ) {
    delta = -4;
  }
  return { delta, reason: summarizeCarrierLaneOutcome(row) };
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

// Keep a referenced re-export so consumers that import the table from this
// module (rather than from @shared/schema directly) continue to work after
// future internal refactors. No-op for tree shaking.
export { carrierLaneOutcomes };
