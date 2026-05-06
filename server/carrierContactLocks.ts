/**
 * Task #631 — Unified carrier contact-lock view.
 *
 * One source of truth for "did we just contact this carrier on this lane?".
 * Read by every send-suppression path so LWQ outreach, Available Freight wave
 * sends, sendOpportunityWave (auto-pilot included), and single-carrier email
 * all share the same dedup window AND surface the same "contacted X via Y by Z"
 * suppression reason on the chip.
 *
 * Lane match strategy (in order of confidence):
 *   1. recurringLaneId match — when the caller has a recurring_lanes id.
 *   2. company + procurement_lane label match — for opportunities without a
 *      recurringLaneId, fall back to a company-scoped match on the
 *      "Origin → Destination" string. Both LWQ AND AF wave now persist the
 *      label on every send so this fallback is symmetric (a synthetic-lane
 *      AF wave write is found by an LWQ lookup and vice versa).
 *
 * Window is `HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours` (48h). Defining
 * it locally would risk drift between dedup paths.
 */

import { db } from "./storage";
import { sql } from "drizzle-orm";

/**
 * Per-carrier dedup window. Inlined (NOT imported from carrierRankingService)
 * to avoid a circular import: carrierRankingService now imports the lock
 * helper to render rich suppression reasons in chips, so the helper cannot
 * depend on the ranker. The value mirrors
 * `HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours` (48h) — keep them in sync.
 */
export const CONTACT_LOCK_WINDOW_HOURS = 48;

export type ContactLockSource =
  | "lwq"
  | "lwq_procurement"
  | "lwq_adhoc"
  | "af_wave"
  | "auto_pilot"
  | "single_carrier"
  | "unknown";

const KNOWN_SOURCES = new Set<ContactLockSource>([
  "lwq",
  "lwq_procurement",
  "lwq_adhoc",
  "af_wave",
  "auto_pilot",
  "single_carrier",
  "unknown",
]);

/** Normalize a raw source_module string from the DB into the typed union. */
export function normalizeContactLockSource(raw: string | null | undefined): ContactLockSource {
  if (!raw) return "unknown";
  return KNOWN_SOURCES.has(raw as ContactLockSource) ? (raw as ContactLockSource) : "unknown";
}

export interface ContactLockQuery {
  orgId: string;
  /** Carriers to check. An empty array short-circuits to an empty result. */
  carrierIds: string[];
  /** When set, lane_id matches are considered. */
  recurringLaneId: string | null;
  /** Required for the company+label fallback path. */
  companyId: string | null;
  /** "Chicago, IL → Dallas, TX" — required for the company+label fallback path. */
  laneLabel: string | null;
  /** Override the default 48h window (e.g. tests). */
  windowHours?: number;
}

export interface ContactLock {
  carrierId: string;
  lastSentAt: Date;
  source: ContactLockSource;
  actorUserId: string | null;
  actorName: string | null;
  matchedBy: "lane_id" | "company_lane_label";
  outreachLogId: string;
}

/**
 * Canonical lane label used for the company+label match fallback. Every send
 * path persists this string into `carrier_outreach_logs.procurement_lane` so a
 * later dedup query can match by company + label even when the source path
 * had no recurringLaneId (AF synthetic-lane opps).
 *
 * Returns null when origin or destination is missing — the lookup falls back
 * to lane-id-only in that case.
 */
export function formatLaneLabel(
  origin: string | null | undefined,
  destination: string | null | undefined,
): string | null {
  const o = (origin ?? "").trim();
  const d = (destination ?? "").trim();
  if (!o || !d) return null;
  return `${o} → ${d}`;
}

/**
 * Find the most-recent contact lock per carrier in the requested set within
 * the dedup window. The result map only contains carriers that ARE locked.
 * Carriers not present in the result are free to be contacted.
 */
export async function findCarrierContactLocks(
  q: ContactLockQuery,
): Promise<Map<string, ContactLock>> {
  const out = new Map<string, ContactLock>();
  if (q.carrierIds.length === 0) return out;
  if (!q.recurringLaneId && !(q.companyId && q.laneLabel)) {
    // No usable match key — caller must provide at least one path. Return
    // empty rather than scan the whole org (would be a major footgun).
    return out;
  }

  const windowHours = q.windowHours ?? CONTACT_LOCK_WINDOW_HOURS;

  // Single SQL query union'ing both match strategies in one round-trip. The
  // CASE WHEN populates `matched_by` so callers can show whether the lock came
  // from a precise lane-id match or a fuzzier company+label match.
  //
  // 'partial' rows are admitted so procurement batch sends that succeeded for
  // SOME carriers still lock those carriers — but the outer EXISTS check on
  // jsonb_array_elements(recipients) ensures we ONLY lock the specific carrier
  // IDs whose per-recipient status is also a success. That avoids the
  // false-positive where a carrier whose individual send failed (in the same
  // batch row as a successful send) gets erroneously locked out for 48h.
  const r = await db.execute(sql`
    WITH locks AS (
      SELECT
        col.id            AS log_id,
        unnest(col.carrier_ids) AS carrier_id,
        col.sent_at       AS sent_at,
        col.source_module AS source_module,
        col.actor_user_id AS actor_user_id,
        col.delivery_status AS delivery_status,
        col.recipients    AS recipients,
        u.name            AS actor_name,
        CASE
          WHEN ${q.recurringLaneId}::varchar IS NOT NULL
            AND col.lane_id = ${q.recurringLaneId}::varchar
          THEN 'lane_id'
          ELSE 'company_lane_label'
        END               AS matched_by
      FROM carrier_outreach_logs col
      LEFT JOIN users u ON u.id = col.actor_user_id
      WHERE col.org_id = ${q.orgId}
        AND col.direction = 'outbound'
        AND col.delivery_status IN ('sent','delivered','opened','partial')
        AND col.sent_at IS NOT NULL
        AND col.sent_at > NOW() - (${windowHours} || ' hours')::interval
        AND col.carrier_ids && ${q.carrierIds}::text[]
        AND (
          (
            ${q.recurringLaneId}::varchar IS NOT NULL
            AND col.lane_id = ${q.recurringLaneId}::varchar
          )
          OR (
            ${q.companyId}::varchar IS NOT NULL
            AND ${q.laneLabel}::text IS NOT NULL
            AND col.company_id = ${q.companyId}::varchar
            AND col.procurement_lane IS NOT NULL
            AND LOWER(col.procurement_lane) = LOWER(${q.laneLabel}::text)
          )
        )
    )
    SELECT log_id, carrier_id, sent_at, source_module, actor_user_id, actor_name, matched_by
    FROM locks
    WHERE carrier_id = ANY(${q.carrierIds}::text[])
      AND (
        delivery_status <> 'partial'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(recipients, '[]'::jsonb)) AS r
          WHERE r->>'carrierId' = carrier_id
            AND r->>'status' IN ('sent','scheduled','delivered','opened')
        )
      )
    ORDER BY sent_at DESC
  `);

  const rows = (r as { rows?: unknown[] }).rows ?? [];
  for (const row of rows as Array<{
    log_id: string;
    carrier_id: string;
    sent_at: string | Date;
    source_module: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    matched_by: "lane_id" | "company_lane_label";
  }>) {
    if (out.has(row.carrier_id)) continue; // first row wins (DESC by sent_at)
    if (!q.carrierIds.includes(row.carrier_id)) continue;
    out.set(row.carrier_id, {
      carrierId: row.carrier_id,
      lastSentAt: row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at),
      source: normalizeContactLockSource(row.source_module),
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      matchedBy: row.matched_by,
      outreachLogId: row.log_id,
    });
  }
  return out;
}

function ageString(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function sourceDisplayName(source: ContactLockSource): string {
  switch (source) {
    case "lwq": return "LWQ";
    case "lwq_procurement": return "LWQ procurement";
    case "lwq_adhoc": return "LWQ ad-hoc";
    case "af_wave": return "Available Freight";
    case "auto_pilot": return "auto-pilot";
    case "single_carrier": return "single-carrier email";
    case "unknown": return "outreach";
  }
}

/**
 * Build a human suppression reason string for a chip / blocked-send message.
 * "Contacted 2h ago via LWQ by Sara" / "Contacted 30m ago via auto-pilot".
 *
 * Auto-pilot omits the actor name because the actor user is the policy owner,
 * not the rep that "did the send" — saying "by Sara" implies Sara clicked send
 * when she actually just owns the policy.
 */
export function formatLockReason(lock: ContactLock, now: Date = new Date()): string {
  const age = ageString(lock.lastSentAt, now);
  const src = sourceDisplayName(lock.source);
  if (lock.actorName && lock.source !== "auto_pilot") {
    return `Contacted ${age} via ${src} by ${lock.actorName}`;
  }
  return `Contacted ${age} via ${src}`;
}
