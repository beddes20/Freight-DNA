// Task #638 — Per-(rep, carrier, lane, day) override ledger.
// Negative reasons cap fitScore (1→60, 2→40, 3+→20); better_fit adds +12.
// Dismiss writes reason_code=null (audit-only, no score impact).
import { sql } from "drizzle-orm";
import { db } from "../storage";
import {
  carrierOverrides,
  type CarrierOverrideAction,
  type CarrierOverrideReasonCode,
} from "@shared/schema";
import { laneSig } from "../laneCrossLinkService";

const NOTES_MAX_CHARS = 240;

// "other" is bucketed negative — reps pick it when no specific label fits.
const NEGATIVE_REASONS: ReadonlySet<CarrierOverrideReasonCode> = new Set([
  "bad_service",
  "out_of_equipment",
  "wont_run_lane",
  "other",
]);

const POSITIVE_REASONS: ReadonlySet<CarrierOverrideReasonCode> = new Set([
  "better_fit",
]);

// Matches priorOutcomeBoost in carrierRankingService.
const POSITIVE_BOOST = 12;

function negativeCapForCount(n: number): number {
  if (n <= 0) return Infinity;
  if (n === 1) return 60;
  if (n === 2) return 40;
  return 20;
}

const REASON_LABELS: Record<CarrierOverrideReasonCode, string> = {
  bad_service: "bad service",
  out_of_equipment: "out of equipment",
  wont_run_lane: "won't run lane",
  better_fit: "Better fit",
  other: "other",
};

export function isCarrierOverrideReasonCode(v: unknown): v is CarrierOverrideReasonCode {
  return typeof v === "string"
    && (v === "bad_service" || v === "out_of_equipment" || v === "wont_run_lane"
      || v === "better_fit" || v === "other");
}

export function isCarrierOverrideAction(v: unknown): v is CarrierOverrideAction {
  return v === "deselect_top3" || v === "added_outside_topn";
}

export interface RecordCarrierOverrideInput {
  orgId: string;
  carrierId: string;
  repId: string;
  /** Pre-computed signature, or omit to derive from lane parts below. */
  laneSignature?: string;
  origin?: string | null;
  originState?: string | null;
  destination?: string | null;
  destinationState?: string | null;
  equipmentType?: string | null;
  /** null when rep dismissed the picker without choosing a reason. */
  reasonCode: CarrierOverrideReasonCode | null;
  action: CarrierOverrideAction;
  notes?: string | null;
  /** Override for tests/back-fill; defaults to NOW. */
  occurredAt?: Date;
}

export interface RecordCarrierOverrideResult {
  /** True when a brand-new row was written; false when the dedupe index hit. */
  recorded: boolean;
}

/** UTC YYYY-MM-DD — must match the storage format used by the unique index. */
function toUtcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function recordCarrierOverride(
  input: RecordCarrierOverrideInput,
): Promise<RecordCarrierOverrideResult> {
  if (!input.orgId || !input.carrierId || !input.repId) {
    throw new Error("recordCarrierOverride: orgId, carrierId, repId required");
  }
  const signature = input.laneSignature ?? laneSig(
    input.origin ?? null,
    input.originState ?? null,
    input.destination ?? null,
    input.destinationState ?? null,
    input.equipmentType ?? null,
  );
  // Reject all-separator sigs ("|||" etc.) so the unique index stays meaningful.
  if (!signature || /^\|*$/.test(signature)) {
    throw new Error("recordCarrierOverride: laneSignature could not be derived");
  }
  const occurredAt = input.occurredAt ?? new Date();
  const occurredAtDay = toUtcDayString(occurredAt);
  const notes = (input.notes ?? "").trim().slice(0, NOTES_MAX_CHARS) || null;

  // ON CONFLICT DO NOTHING + RETURNING — caller distinguishes new write vs dedup hit.
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO carrier_overrides (
      org_id, carrier_id, lane_signature,
      origin, origin_state, destination, destination_state, equipment_type,
      reason_code, action, notes, rep_id, occurred_at, occurred_at_day
    ) VALUES (
      ${input.orgId}, ${input.carrierId}, ${signature},
      ${input.origin ?? null}, ${input.originState ?? null},
      ${input.destination ?? null}, ${input.destinationState ?? null},
      ${input.equipmentType ?? null},
      ${input.reasonCode}, ${input.action}, ${notes},
      ${input.repId}, ${occurredAt.toISOString()}, ${occurredAtDay}
    )
    ON CONFLICT (org_id, carrier_id, lane_signature, rep_id, occurred_at_day)
      DO NOTHING
    RETURNING id
  `);
  const rows = inserted.rows ?? [];
  return { recorded: rows.length > 0 };
}

// Aggregate per (orgId, carrierId, lane). Fed to carrierOverridePrior().
export interface CarrierOverrideAggregate {
  carrierId: string;
  laneSignature: string;
  negativeCount: number;
  positiveCount: number;
  /** Most-recent NEGATIVE reason code (null if all negatives were dismissals). */
  lastNegativeReason: CarrierOverrideReasonCode | null;
  lastOccurredAt: Date | null;
}

// One row per carrier with at least one override on (org, lane). Empty otherwise.
export async function getCarrierOverridesForLane(
  orgId: string,
  laneSignature: string,
): Promise<Map<string, CarrierOverrideAggregate>> {
  const out = new Map<string, CarrierOverrideAggregate>();
  if (!orgId || !laneSignature) return out;

  interface AggregateRow {
    carrierId: string;
    negativeCount: string | number;
    positiveCount: string | number;
    lastNegativeReason: string | null;
    lastOccurredAt: string | Date | null;
  }
  // Soft-fail: ranker is hot-path; a DB hiccup should degrade to
  // "no prior", not break the rank pass (mirrors getCarrierLaneOutcomesForLane).
  try {
    const result = await db.execute<AggregateRow>(sql`
      SELECT
        carrier_id                                                 AS "carrierId",
        COUNT(*) FILTER (WHERE reason_code IN ('bad_service','out_of_equipment','wont_run_lane','other'))
                                                                   AS "negativeCount",
        COUNT(*) FILTER (WHERE reason_code = 'better_fit')         AS "positiveCount",
        (
          SELECT reason_code FROM carrier_overrides co2
          WHERE  co2.org_id = co.org_id
            AND  co2.carrier_id = co.carrier_id
            AND  co2.lane_signature = co.lane_signature
            AND  co2.reason_code IN ('bad_service','out_of_equipment','wont_run_lane','other')
          ORDER BY co2.occurred_at DESC
          LIMIT 1
        )                                                          AS "lastNegativeReason",
        MAX(occurred_at)                                           AS "lastOccurredAt"
      FROM carrier_overrides co
      WHERE org_id = ${orgId} AND lane_signature = ${laneSignature}
      GROUP BY carrier_id, org_id, lane_signature
    `);

    for (const r of result.rows ?? []) {
      out.set(r.carrierId, {
        carrierId: r.carrierId,
        laneSignature,
        negativeCount: Number(r.negativeCount) || 0,
        positiveCount: Number(r.positiveCount) || 0,
        lastNegativeReason: isCarrierOverrideReasonCode(r.lastNegativeReason)
          ? (r.lastNegativeReason as CarrierOverrideReasonCode)
          : null,
        lastOccurredAt: r.lastOccurredAt ? new Date(r.lastOccurredAt) : null,
      });
    }
  } catch (err) {
    console.warn(
      "[carrier-overrides] read failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

// Pure function — turns one aggregate into the ranker prior.
// boost adds to fitScore; cap is applied AFTER the boost (negatives win ties).
export interface CarrierOverridePrior {
  boost: number;
  cap: number;
  reasons: string[];
}

export function carrierOverridePrior(agg: CarrierOverrideAggregate): CarrierOverridePrior {
  const reasons: string[] = [];
  let boost = 0;
  let cap = Infinity;

  if (agg.positiveCount > 0) {
    boost += POSITIVE_BOOST;
    const times = agg.positiveCount === 1 ? "1×" : `${agg.positiveCount}×`;
    reasons.push(`Manually preferred ${times} ('${REASON_LABELS.better_fit}')`);
  }

  if (agg.negativeCount > 0) {
    cap = negativeCapForCount(agg.negativeCount);
    const times = agg.negativeCount === 1 ? "1×" : `${agg.negativeCount}×`;
    const tail = agg.lastNegativeReason
      ? `: ${REASON_LABELS[agg.lastNegativeReason]}`
      : "";
    reasons.push(`Skipped ${times} by reps${tail}`);
  }

  return { boost, cap, reasons };
}
