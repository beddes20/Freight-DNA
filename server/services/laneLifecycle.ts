// Task #1026 (LWQ A) — server-side lifecycle evaluator + persister.
//
// `recomputeLaneLifecycleStage()` is the **only** writer of
// `recurring_lanes.lifecycle_stage` (a guardrail in
// `tests/code-quality-guardrails.test.ts` enforces this). All write paths
// that mutate signals feeding the derivation — lane upserts, outreach log
// creation, financial-upload ingest — call this helper after their write
// so the persisted stage stays in sync with the live signals.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  recurringLanes,
  carrierOutreachLogs,
  laneCarrierInterest,
  loadFact,
  type RecurringLane,
} from "@shared/schema";
import {
  deriveLaneLifecycleStage,
  type LaneLifecycleStage,
  type LaneOutreachStats,
} from "@shared/laneLifecycle";

const ENGAGED_INTEREST_STATUSES = new Set([
  "available_now",
  "available_next_week",
  "future_interest",
]);

const norm = (s: string | null | undefined) =>
  (s ?? "").toString().trim().toLowerCase();

/**
 * Pull the per-lane outreach signals the pure derivation needs.
 * Returns counts plus the timestamp of the first outreach attempt
 * (used by the Operationalized post-outreach check).
 */
export async function loadLaneOutreachStats(
  laneId: string,
): Promise<{ stats: LaneOutreachStats; firstOutreachAt: Date | null }> {
  // Outreach attempts: rows with sentAt set (covers both the bulk send
  // path which writes deliveryStatus='sent' + sentAt, and the ad-hoc
  // /outreach-log path which also stamps sentAt). Assignment /
  // reassignment audit rows have sentAt NULL and are correctly excluded.
  // The Operationalized anchor uses the row-creation timestamp per
  // Task #1026 spec — that's when the attempt was logged in the system,
  // which is what we compare pickup dates against. In this schema the
  // creation column is named `timestamp` (`defaultNow().notNull()`), not
  // `createdAt`.
  const attemptRows = await db
    .select({
      createdAt: carrierOutreachLogs.timestamp,
      replyReceivedAt: carrierOutreachLogs.replyReceivedAt,
    })
    .from(carrierOutreachLogs)
    .where(
      and(
        eq(carrierOutreachLogs.laneId, laneId),
        isNotNull(carrierOutreachLogs.sentAt),
      ),
    );

  let outreachAttemptCount = 0;
  let firstOutreachAt: Date | null = null;
  let replyCount = 0;
  for (const r of attemptRows) {
    outreachAttemptCount++;
    if (r.createdAt) {
      const t = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
      if (!Number.isNaN(t.getTime()) && (firstOutreachAt === null || t < firstOutreachAt)) {
        firstOutreachAt = t;
      }
    }
    if (r.replyReceivedAt) replyCount++;
  }

  // Bench-side engagement signals.
  const benchRows = await db
    .select({
      interestStatus: laneCarrierInterest.interestStatus,
      // contactable proxy: a bench row counts as contactable when it has
      // a resolved carrierId (the catalog row carries email metadata).
      // The same heuristic is used by `lane_summary_cache.contactable_count`
      // when its writer projects bench → lean. Keeping it cheap here
      // avoids the carriers-table join inside this hot path.
      carrierId: laneCarrierInterest.carrierId,
    })
    .from(laneCarrierInterest)
    .where(eq(laneCarrierInterest.laneId, laneId));

  let contactableCount = 0;
  let engagedFromBench = 0;
  for (const b of benchRows) {
    if (b.carrierId) contactableCount++;
    if (b.interestStatus && ENGAGED_INTEREST_STATUSES.has(b.interestStatus)) {
      engagedFromBench++;
    }
  }

  return {
    stats: {
      outreachAttemptCount,
      engagedReplyCount: replyCount + engagedFromBench,
      contactableCount,
    },
    firstOutreachAt,
  };
}

/**
 * Operationalized check — returns true iff at least one realized
 * (covered/won) load_fact row matches the lane signature
 * (`origin|originState|destination|destinationState|equipmentType`) for
 * the same `companyId` AND has a pickup date STRICTLY AFTER
 * `firstOutreachAt`. The post-outreach ordering is what differentiates
 * "we landed capacity here because of LWQ outreach" from "this lane
 * already had freight running". When `firstOutreachAt` is null the
 * function returns false — Operationalized requires outreach to exist.
 */
export async function coveredLoadAfterFirstOutreachAttempt(
  lane: Pick<RecurringLane,
    "orgId" | "companyId" | "origin" | "originState" |
    "destination" | "destinationState" | "equipmentType"
  >,
  firstOutreachAt: Date | null,
): Promise<boolean> {
  if (!firstOutreachAt) return false;
  if (!lane.companyId) return false;

  const pickupCutoff = firstOutreachAt.toISOString();

  // load_fact stores pickup_date as text (TMS extract preserved as-is).
  // We do a lexicographic ISO/`YYYY-MM-DD` comparison which is correct
  // for both formats produced by the importer.
  const realizedGuard = sql`(LOWER(COALESCE(${loadFact.moveStatus},'')) LIKE '%deliver%' OR ${loadFact.bucket} = 'realized')`;

  const [hit] = await db
    .select({ id: loadFact.id })
    .from(loadFact)
    .where(
      and(
        eq(loadFact.orgId, lane.orgId),
        eq(loadFact.companyId, lane.companyId),
        sql`lower(trim(coalesce(${loadFact.originCity},''))) = ${norm(lane.origin)}`,
        sql`lower(trim(coalesce(${loadFact.originState},''))) = ${norm(lane.originState)}`,
        sql`lower(trim(coalesce(${loadFact.destinationCity},''))) = ${norm(lane.destination)}`,
        sql`lower(trim(coalesce(${loadFact.destinationState},''))) = ${norm(lane.destinationState)}`,
        sql`lower(trim(coalesce(${loadFact.equipmentType},''))) = ${norm(lane.equipmentType)}`,
        realizedGuard,
        sql`${loadFact.pickupDate} IS NOT NULL`,
        sql`${loadFact.pickupDate} > ${pickupCutoff}`,
      ),
    )
    .limit(1);

  return !!hit;
}

/**
 * Evaluate (without persisting) the lifecycle stage for a lane.
 * Used by the boot-time backfill so we can batch-update without
 * triggering a recursive write hook.
 */
export async function evaluateLaneLifecycleStage(
  lane: RecurringLane,
): Promise<LaneLifecycleStage> {
  const { stats, firstOutreachAt } = await loadLaneOutreachStats(lane.id);
  const covered = await coveredLoadAfterFirstOutreachAttempt(lane, firstOutreachAt);
  return deriveLaneLifecycleStage(
    {
      isEligible: lane.isEligible,
      eligibilityConfidence: lane.eligibilityConfidence,
      ownerUserId: lane.ownerUserId,
      carriersContactedCount: lane.carriersContactedCount,
    },
    stats,
    covered,
  );
}

/**
 * Recompute and persist `lifecycle_stage` for a single lane. This is the
 * **only** writer of the column; storage upsert/update, outreach log
 * creation and financial-upload ingest call it after their writes. Safe
 * to call concurrently — the UPDATE only writes when the stage changes.
 */
export async function recomputeLaneLifecycleStage(
  laneId: string,
): Promise<LaneLifecycleStage | null> {
  const [lane] = await db
    .select()
    .from(recurringLanes)
    .where(eq(recurringLanes.id, laneId))
    .limit(1);
  if (!lane) return null;

  const next = await evaluateLaneLifecycleStage(lane);
  if (lane.lifecycleStage === next) return next;

  await db
    .update(recurringLanes)
    .set({ lifecycleStage: next })
    .where(eq(recurringLanes.id, laneId));

  return next;
}

/**
 * Best-effort wrapper used by the storage write hooks. Logs but never
 * throws — a lifecycle recompute failure must not break the originating
 * write (lane upsert, outreach log, etc).
 */
export async function recomputeLaneLifecycleStageSafe(
  laneId: string | null | undefined,
): Promise<void> {
  if (!laneId) return;
  try {
    await recomputeLaneLifecycleStage(laneId);
  } catch (err) {
    console.error(`[lane-lifecycle] recompute failed for lane=${laneId}:`, err);
  }
}

/**
 * Recompute every lane belonging to an org. Used by the financial-upload
 * ingest hook — a fresh upload can flip many lanes to Operationalized at
 * once. Sequential (not parallel) to keep DB load bounded.
 */
export async function recomputeOrgLaneLifecycleStages(
  orgId: string,
): Promise<{ scanned: number; updated: number }> {
  const lanes = await db
    .select()
    .from(recurringLanes)
    .where(eq(recurringLanes.orgId, orgId))
    .orderBy(desc(recurringLanes.updatedAt));
  let updated = 0;
  for (const lane of lanes) {
    try {
      const next = await evaluateLaneLifecycleStage(lane);
      if (lane.lifecycleStage !== next) {
        await db
          .update(recurringLanes)
          .set({ lifecycleStage: next })
          .where(eq(recurringLanes.id, lane.id));
        updated++;
      }
    } catch (err) {
      console.error(`[lane-lifecycle] org recompute failed for lane=${lane.id}:`, err);
    }
  }
  return { scanned: lanes.length, updated };
}
