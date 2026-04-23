/**
 * My Procurement Routes
 *
 * ENDPOINT INTENT AUDIT (Task #200):
 *
 * GET /api/my-procurement
 *   PURPOSE: Personal procurement work surface — lean list, no per-lane enrichment.
 *   RETURNS (lwqLanes): laneId, origin, destination, equipmentType, avgLoadsPerWeek,
 *     laneScore, companyId, companyName, ownerUserId, assignedAt, carriersContactedCount,
 *     isManual. NO replySummary, no bench arrays, no history objects.
 *   RETURNS (awardTasks): taskId, title, status, dueDate, companyId, customerName,
 *     awardTitle, matchedLaneId. NO full lane object, NO replySummary.
 *   PAGINATION: limit + cursor (keyset) on both buckets. Default page size 50.
 *
 * enriched replySummary / bench data is loaded lazily via:
 *   GET /api/recurring-lanes/:id/detail  (when panel opens)
 */

import type { Express } from "express";
import { storage, db } from "../storage";
import { getCurrentUser } from "../auth";
import { normalizeLaneLocation, normalizeEquipmentType } from "@shared/laneFormatters";
import { and, desc, eq, or, inArray, gte, isNull, sql } from "drizzle-orm";
import { plays, playRuns, freightOpportunities, emailSignals, type InsertFreightOpportunity } from "@shared/schema";
import { evaluatePlayTriggersForOrg } from "./playbook";
import { performAvailableFreightImport, listAvailableFreightImports, availableFreightSettingKey } from "../availableFreightImporter";
import { notifyFreightDelegated, notifyFreightApproved } from "../freightOpportunityNotifications";
import { computeSlaState, countOverSlaForOrg, SLA_L1_HOURS, SLA_L2_HOURS } from "../freightOpportunitySlaService";
import { z } from "zod";

const APPROVER_ROLES = new Set([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "logistics_manager",
]);

/**
 * Read-only visibility for queues (LWQ today, more later).
 *
 * A user sees lanes/freight where:
 *   - owner_user_id is themselves OR their immediate manager  (direct-manager rule), OR
 *   - company_id is an account they were explicitly added to as a collaborator.
 *
 * Mutation auth elsewhere stays strict (owner/delegated only). org_id is still
 * required on every read as a defense-in-depth tenant check.
 */
async function getLwqVisibility(user: {
  id: string;
  organizationId: string;
  managerId?: string | null;
}): Promise<{ ownerIds: string[]; companyIds: string[] }> {
  const ownerIds = new Set<string>([user.id]);
  if (user.managerId) ownerIds.add(user.managerId);
  const companyIds = await storage.getCollaboratorCompanyIds(user.id, user.organizationId);
  return { ownerIds: Array.from(ownerIds), companyIds };
}

/**
 * SQL expression that applies the same normalization as normalizeLaneLocation() to a column.
 * Matches: lowercase, trimmed, single-space collapse, comma-space normalization.
 */
const SQL_NORM = (col: string) =>
  `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(${col}), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g'))`;

export function registerMyProcurementRoutes(app: Express) {
  /**
   * GET /api/my-procurement
   *
   * Returns two lean buckets for the authenticated user:
   *   1. lwqLanes   — recurring_lanes where ownerUserId = me, resolved_at IS NULL
   *                   Lean: no replySummary, no bench arrays
   *   2. awardTasks — tasks where assignedTo = me AND type = "carrier_procurement"
   *                   Lean: taskId, title, status, dueDate, customerName, awardTitle, matchedLaneId only
   *
   * Pagination: ?limit=50&cursor=<keyset> on both buckets (independent cursors).
   */
  app.get("/api/my-procurement", async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Unauthorized" });

      // Optional ?userId= lets privileged roles view another rep's queue (read-only).
      // Allowed roles: admin (any user in org), or
      //   director / sales_director / national_account_manager / logistics_manager
      //   restricted to users in their reporting chain.
      const requestedUserId = (req.query.userId as string | undefined) || null;
      let user = viewer;
      let viewing: { id: string; name: string; isOther: boolean } | null = null;
      if (requestedUserId && requestedUserId !== viewer.id) {
        const VIEWER_ROLES = new Set([
          "admin",
          "director",
          "sales_director",
          "national_account_manager",
          "logistics_manager",
        ]);
        if (!VIEWER_ROLES.has(viewer.role)) {
          return res.status(403).json({ error: "Not allowed to view another user's procurement" });
        }
        const target = await storage.getUser(requestedUserId);
        if (!target || target.organizationId !== viewer.organizationId) {
          return res.status(404).json({ error: "User not found" });
        }
        if (viewer.role !== "admin") {
          const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
          if (!teamIds.includes(target.id)) {
            return res.status(403).json({ error: "Target user is not in your team" });
          }
        }
        user = target;
        viewing = { id: target.id, name: target.name ?? target.email ?? target.id, isOther: true };
      }

      // Pagination params — default page size 50, max 200
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const lanesCursor = req.query.lanesCursor as string | undefined;
      const tasksCursor = req.query.tasksCursor as string | undefined;

      // Per-bucket error capture so a single failing query no longer blanks
      // the whole queue. Buckets that fail return their safe-empty default
      // and we surface a non-fatal `bucketErrors` array in the response so
      // ops can see *which* sub-query broke without hunting prod logs.
      const bucketErrors: string[] = [];
      const noteFailure = (bucket: string, err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[my-procurement] bucket=${bucket} viewer=${viewer.id} target=${user.id} role=${viewer.role}:`, err);
        bucketErrors.push(`${bucket}: ${msg}`);
      };

      // ── 1. My lanes — prefer lane_summary_cache (lean, pre-computed), fall back to recurring_lanes ──
      // Cache path: no joins, no per-lane bench enrichment — just the pre-scored fields.
      let vis: { ownerIds: string[]; companyIds: string[] };
      try {
        vis = await getLwqVisibility(user);
      } catch (visErr) {
        noteFailure("visibility", visErr);
        vis = { ownerIds: [user.id], companyIds: [] };
      }
      let cacheRows: { rows: Array<{
        lane_id: string;
        origin: string;
        origin_state: string | null;
        destination: string;
        destination_state: string | null;
        equipment_type: string | null;
        avg_loads_per_week: string | null;
        lane_score: number | null;
        company_id: string | null;
        company_name: string | null;
        owner_user_id: string | null;
        carriers_contacted_count: number;
        has_cache: boolean;
      }> } = { rows: [] };
      try {
        cacheRows = await storage.pool.query(
        `SELECT
           lsc.lane_id,
           lsc.origin,
           lsc.origin_state,
           lsc.destination,
           lsc.destination_state,
           lsc.equipment_type,
           lsc.avg_loads_per_week::text,
           lsc.lane_score,
           lsc.company_id,
           lsc.company_name,
           lsc.owner_user_id,
           COALESCE(lsc.carriers_contacted_count, 0) AS carriers_contacted_count,
           true AS has_cache
         FROM lane_summary_cache lsc
         WHERE (
             lsc.owner_user_id = ANY($1::varchar[])
             OR lsc.company_id = ANY($3::varchar[])
           )
           AND lsc.org_id = $2
           AND lsc.resolved_at IS NULL
         ORDER BY lsc.lane_score DESC NULLS LAST, lsc.lane_id`,
        // Visibility: own lanes + immediate-manager lanes (param 1)
        // OR lanes whose company the user was explicitly added to as a
        // collaborator (param 3). org_id is required as a tenant guard.
        [vis.ownerIds, user.organizationId, vis.companyIds]
      );
      } catch (cacheErr) {
        noteFailure("lwq.cache", cacheErr);
        cacheRows = { rows: [] };
      }

      let lwqLanesAll: Array<{
        laneId: string;
        origin: string;
        originState: string | null;
        destination: string;
        destinationState: string | null;
        equipmentType: string | null;
        avgLoadsPerWeek: string | null;
        laneScore: number | null;
        companyId: string | null;
        companyName: string | null;
        ownerUserId: string | null;
        carriersContactedCount: number;
      }>;

      if (cacheRows.rows.length > 0) {
        lwqLanesAll = cacheRows.rows.map((r) => ({
          laneId: r.lane_id,
          origin: r.origin,
          originState: r.origin_state,
          destination: r.destination,
          destinationState: r.destination_state,
          equipmentType: r.equipment_type,
          avgLoadsPerWeek: r.avg_loads_per_week,
          laneScore: r.lane_score,
          companyId: r.company_id,
          companyName: r.company_name,
          ownerUserId: r.owner_user_id,
          carriersContactedCount: r.carriers_contacted_count,
        }));
      } else {
        // Fall back to recurring_lanes when cache is empty (first run)
        try {
        const fallbackRows = await storage.pool.query<{
          id: string;
          origin: string;
          origin_state: string | null;
          destination: string;
          destination_state: string | null;
          equipment_type: string | null;
          avg_loads_per_week: string | null;
          lane_score: number | null;
          company_id: string | null;
          company_name: string | null;
          owner_user_id: string | null;
          carriers_contacted_count: number | null;
        }>(
          `SELECT
             rl.id,
             rl.origin,
             rl.origin_state,
             rl.destination,
             rl.destination_state,
             rl.equipment_type,
             rl.avg_loads_per_week,
             rl.lane_score,
             rl.company_id,
             COALESCE(rl.company_name, c.name) AS company_name,
             rl.owner_user_id,
             rl.carriers_contacted_count
           FROM recurring_lanes rl
           LEFT JOIN companies c ON c.id = rl.company_id
           WHERE (
               rl.owner_user_id = ANY($1::varchar[])
               OR rl.company_id = ANY($3::varchar[])
             )
             AND rl.org_id = $2
             AND rl.resolved_at IS NULL
           ORDER BY rl.lane_score DESC NULLS LAST`,
          [vis.ownerIds, user.organizationId, vis.companyIds]
        );
        lwqLanesAll = fallbackRows.rows.map((r) => ({
          laneId: r.id,
          origin: r.origin,
          originState: r.origin_state,
          destination: r.destination,
          destinationState: r.destination_state,
          equipmentType: r.equipment_type,
          avgLoadsPerWeek: r.avg_loads_per_week,
          laneScore: r.lane_score,
          companyId: r.company_id,
          companyName: r.company_name,
          ownerUserId: r.owner_user_id,
          carriersContactedCount: r.carriers_contacted_count ?? 0,
        }));
        } catch (fbErr) {
          noteFailure("lwq.fallback", fbErr);
          lwqLanesAll = [];
        }
      }

      // Apply cursor pagination for lwqLanes (keyset by laneScore DESC, laneId)
      if (lanesCursor) {
        const [cursorScoreStr, cursorId] = lanesCursor.split(":");
        const cursorScore = parseInt(cursorScoreStr, 10);
        const cursorIdx = lwqLanesAll.findIndex(l => {
          const score = l.laneScore ?? 0;
          if (score !== cursorScore) return score < cursorScore;
          return l.laneId > cursorId;
        });
        if (cursorIdx !== -1) lwqLanesAll = lwqLanesAll.slice(cursorIdx);
      }
      const lwqLanes = lwqLanesAll.slice(0, limit);
      const lastLwqLane = lwqLanes[lwqLanes.length - 1];
      const lwqNextCursor = lwqLanes.length === limit && lastLwqLane
        ? `${lastLwqLane.laneScore ?? 0}:${lastLwqLane.laneId}`
        : null;

      // ── 2. Award carrier-procurement tasks assigned to me (lean) ──────────
      let taskRows: { rows: Array<{
        id: string;
        title: string;
        status: string;
        due_date: string | null;
        company_id: string | null;
        created_at: string | null;
        attached_lane_data: unknown;
      }> } = { rows: [] };
      try {
        taskRows = await storage.pool.query(
        `SELECT
           t.id,
           t.title,
           t.status,
           t.due_date,
           t.company_id,
           t.created_at,
           t.attached_lane_data
         FROM tasks t
         WHERE t.assigned_to = $1
           AND t.org_id = $2
           AND t.status = 'open'
           AND t.attached_lane_data IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(t.attached_lane_data::jsonb) AS elem
             WHERE elem->>'type' = 'carrier_procurement'
           )
         ORDER BY t.created_at DESC`,
        [user.id, user.organizationId]
      );
      } catch (taskErr) {
        noteFailure("awardTasks.query", taskErr);
        taskRows = { rows: [] };
      }

      // Parse award task metadata — lean shape only (no replySummary, no full lane object)
      type LeanAwardTask = {
        taskId: string;
        title: string;
        status: string;
        dueDate: string | null;
        companyId: string | null;
        createdAt: string | null;
        origin: string | null;
        destination: string | null;
        awardId: string | null;
        awardTitle: string | null;
        customerName: string | null;
        equipmentType: string | null;
        matchedLaneId: string | null;
      };

      const rawTasks: LeanAwardTask[] = taskRows.rows.map((r) => {
        const laneData: Array<Record<string, unknown>> = Array.isArray(r.attached_lane_data)
          ? (r.attached_lane_data as Array<Record<string, unknown>>)
          : [];
        const proc = laneData.find((e) => e["type"] === "carrier_procurement") ?? {};
        return {
          taskId: r.id,
          title: r.title,
          status: r.status,
          dueDate: r.due_date,
          companyId: r.company_id,
          createdAt: r.created_at,
          origin: (proc["origin"] as string) ?? null,
          destination: (proc["destination"] as string) ?? null,
          awardId: (proc["awardId"] as string) ?? null,
          awardTitle: (proc["awardTitle"] as string) ?? null,
          customerName: (proc["customerName"] as string) ?? null,
          equipmentType: (proc["equipmentType"] as string) ?? null,
          matchedLaneId: null,
        };
      });

      // ── 3. Lane ID lookup — match award tasks to recurring_lanes ─────────
      const tasksWithOD = rawTasks.filter((t) => t.origin && t.destination);

      if (tasksWithOD.length > 0) {
        try {
        const pairMap = new Map<string, { normOrigin: string; normDest: string }>();
        for (const t of tasksWithOD) {
          const no = normalizeLaneLocation(t.origin!);
          const nd = normalizeLaneLocation(t.destination!);
          pairMap.set(`${no}|${nd}`, { normOrigin: no, normDest: nd });
        }
        const uniquePairs = [...pairMap.values()];

        const lookupResult = await storage.pool.query<{
          id: string;
          origin_key: string;
          destination_key: string;
          equipment_type: string | null;
        }>(
          `SELECT
             id,
             ${SQL_NORM("origin")} AS origin_key,
             ${SQL_NORM("destination")} AS destination_key,
             equipment_type
           FROM recurring_lanes
           WHERE org_id = $1
             AND (${SQL_NORM("origin")}, ${SQL_NORM("destination")}) IN (${uniquePairs
               .map((_, i) => `($${2 + i * 2}, $${3 + i * 2})`)
               .join(", ")})
           ORDER BY assigned_at DESC NULLS LAST`,
          [
            user.organizationId,
            ...uniquePairs.flatMap((p) => [p.normOrigin, p.normDest]),
          ]
        );

        const lanesByPair = new Map<string, Array<{ id: string; equipment_type: string | null }>>();
        for (const row of lookupResult.rows) {
          const key = `${row.origin_key}|${row.destination_key}`;
          if (!lanesByPair.has(key)) lanesByPair.set(key, []);
          lanesByPair.get(key)!.push({ id: row.id, equipment_type: row.equipment_type });
        }

        for (const task of rawTasks) {
          if (!task.origin || !task.destination) continue;
          const no = normalizeLaneLocation(task.origin);
          const nd = normalizeLaneLocation(task.destination);
          const candidates = lanesByPair.get(`${no}|${nd}`) ?? [];
          if (candidates.length === 0) continue;

          if (task.equipmentType) {
            const targetEquip = normalizeEquipmentType(task.equipmentType);
            const match = candidates.find(
              (c) => normalizeEquipmentType(c.equipment_type) === targetEquip
            );
            task.matchedLaneId = match?.id ?? null;
          } else {
            task.matchedLaneId = candidates[0].id;
          }
        }
        } catch (lookupErr) {
          noteFailure("awardTasks.laneLookup", lookupErr);
        }
      }

      // Apply cursor pagination for awardTasks (keyset by createdAt DESC, id)
      let awardTasksAll = rawTasks;
      if (tasksCursor) {
        const [cursorDate, cursorId] = tasksCursor.split("|");
        const cursorIdx = awardTasksAll.findIndex(t => {
          if (!t.createdAt || t.createdAt < cursorDate) return true;
          if (t.createdAt === cursorDate) return t.taskId > cursorId;
          return false;
        });
        if (cursorIdx !== -1) awardTasksAll = awardTasksAll.slice(cursorIdx);
      }
      const awardTasks = awardTasksAll.slice(0, limit);
      const lastTask = awardTasks[awardTasks.length - 1];
      const tasksNextCursor = awardTasks.length === limit && lastTask
        ? `${lastTask.createdAt ?? ""}|${lastTask.taskId}`
        : null;

      // Triggered Plays bucket (Task #300) — surfaced as actionable items in the
      // rep's procurement queue. Best-effort: failures don't block the response.
      let triggeredPlays: Array<{
        runId: string;
        playId: string;
        playName: string;
        channel: string;
        audience: string;
        suggestedAt: string;
        signalType: string | null;
      }> = [];
      try {
        await evaluatePlayTriggersForOrg(user.organizationId).catch(() => {});
        const rows = await db.select({
          runId: playRuns.id,
          playId: plays.id,
          playName: plays.name,
          channel: plays.channel,
          audience: plays.audience,
          suggestedAt: playRuns.suggestedAt,
          signalType: plays.signalType,
          accountId: playRuns.accountId,
        })
          .from(playRuns)
          .innerJoin(plays, eq(plays.id, playRuns.playId))
          .where(and(
            eq(playRuns.orgId, user.organizationId),
            eq(playRuns.status, "suggested"),
          ))
          .orderBy(desc(playRuns.suggestedAt))
          .limit(20);
        // Rep-scope triggered plays: prefer runs whose accountId matches a
        // company already in the rep's lane work queue or award tasks. If
        // none of the rep's accounts match, fall back to org-wide so the rep
        // still sees newly fired triggers waiting for assignment.
        const repAccountIds = new Set<string>([
          ...lwqLanes.map(l => l.companyId).filter((x): x is string => !!x),
          ...awardTasks.map(t => t.companyId).filter((x): x is string => !!x),
        ]);
        const all = rows.map(r => ({
          runId: r.runId,
          playId: r.playId,
          playName: r.playName,
          channel: r.channel,
          audience: r.audience,
          suggestedAt: r.suggestedAt instanceof Date ? r.suggestedAt.toISOString() : String(r.suggestedAt),
          signalType: r.signalType ?? null,
          accountId: r.accountId ?? null,
        }));
        const scoped = all.filter(p => p.accountId && repAccountIds.has(p.accountId));
        triggeredPlays = (scoped.length > 0 ? scoped : all).map(({ accountId, ...rest }) => rest);
      } catch (pbErr) {
        console.error("[my-procurement] triggered plays warning:", pbErr);
      }

      // ── Available Freight bucket (task #354) ──────────────────────────────
      // Today's open freight opportunities owned by — or delegated to — this
      // rep, surfaced in the new "Available Freight" tab. "Today's open loads"
      // is defined as: status in (new, ready_to_send) AND the pickup window
      // hasn't already closed (pickupWindowEnd >= today, or null when the
      // spreadsheet didn't supply one).
      // pickupWindowEnd is a text column storing ISO date strings (YYYY-MM-DD),
      // so we compare against today's date as a string for correct lexical
      // ordering.
      const todayIso = new Date().toISOString().slice(0, 10);
      // Managers viewing their own queue also see imports that didn't match
      // any rep email (ownerUserId IS NULL AND delegatedToUserId IS NULL).
      // This is the "unassigned import queue" — they need a single place to
      // route those rows to a rep before they go stale.
      const isManagerSelfView = !viewing && APPROVER_ROLES.has(viewer.role);
      const ownershipFilter = isManagerSelfView
        ? or(
            eq(freightOpportunities.ownerUserId, user.id),
            eq(freightOpportunities.delegatedToUserId, user.id),
            and(
              isNull(freightOpportunities.ownerUserId),
              isNull(freightOpportunities.delegatedToUserId),
            ),
          )
        : or(
            eq(freightOpportunities.ownerUserId, user.id),
            eq(freightOpportunities.delegatedToUserId, user.id),
          );

      let freightOppRows: Array<{
        id: string;
        companyId: string;
        origin: string;
        originState: string | null;
        destination: string;
        destinationState: string | null;
        equipmentType: string | null;
        pickupWindowStart: string | null;
        pickupWindowEnd: string | null;
        loadCount: number | null;
        status: string;
        urgencyScore: number | null;
        ownerUserId: string | null;
        delegatedToUserId: string | null;
        approvedAt: Date | string | null;
        approvedById: string | null;
        templateOverrideSubject: string | null;
        templateOverrideBody: string | null;
        sourceFileName: string | null;
        generatedAt: Date | string | null;
      }> = [];
      try {
      freightOppRows = await db.select({
        id: freightOpportunities.id,
        companyId: freightOpportunities.companyId,
        origin: freightOpportunities.origin,
        originState: freightOpportunities.originState,
        destination: freightOpportunities.destination,
        destinationState: freightOpportunities.destinationState,
        equipmentType: freightOpportunities.equipmentType,
        pickupWindowStart: freightOpportunities.pickupWindowStart,
        pickupWindowEnd: freightOpportunities.pickupWindowEnd,
        loadCount: freightOpportunities.loadCount,
        status: freightOpportunities.status,
        urgencyScore: freightOpportunities.urgencyScore,
        ownerUserId: freightOpportunities.ownerUserId,
        delegatedToUserId: freightOpportunities.delegatedToUserId,
        approvedAt: freightOpportunities.approvedAt,
        approvedById: freightOpportunities.approvedById,
        templateOverrideSubject: freightOpportunities.templateOverrideSubject,
        templateOverrideBody: freightOpportunities.templateOverrideBody,
        sourceFileName: freightOpportunities.sourceFileName,
        generatedAt: freightOpportunities.generatedAt,
      })
        .from(freightOpportunities)
        .where(and(
          eq(freightOpportunities.orgId, user.organizationId),
          // Task #365 — surface in-flight statuses too. Reps need visibility
          // into opps that are awaiting carrier reply or customer confirmation
          // (so they don't double-pitch and so the queue reflects real WIP).
          // Terminal states (covered/expired/cancelled) stay excluded.
          inArray(freightOpportunities.status, [
            "new",
            "ready_to_send",
            "sent",
            "awaiting_carrier_reply",
            "awaiting_customer_confirm",
            "partially_covered",
          ]),
          or(
            isNull(freightOpportunities.pickupWindowEnd),
            gte(freightOpportunities.pickupWindowEnd, todayIso),
          ),
          ownershipFilter,
        ))
        .orderBy(desc(freightOpportunities.urgencyScore), desc(freightOpportunities.generatedAt))
        // Task #366 — cap the My Procurement bucket at 100 newest. The full
        // list with pagination lives at /available-freight; this endpoint is
        // the rep's "today" surface, not their archive.
        .limit(100);
      } catch (foErr) {
        noteFailure("availableFreight.query", foErr);
        freightOppRows = [];
      }

      const companyIds = Array.from(new Set(freightOppRows.map(r => r.companyId)));
      const companyMap = new Map<string, string>();
      if (companyIds.length > 0) {
        try {
          const cos = await storage.getCompaniesByIds(companyIds, user.organizationId);
          for (const c of cos) companyMap.set(c.id, c.name);
        } catch (cmErr) {
          noteFailure("availableFreight.companies", cmErr);
        }
      }

      // Pull awaiting-approval columns alongside the existing select so we
      // can compute SLA state without rewriting the projection above.
      const slaRowsById = new Map<string, { awaitingSince: Date | null; l1: Date | null; l2: Date | null }>();
      if (freightOppRows.length > 0) {
        try {
          const slaRows = await db.select({
            id: freightOpportunities.id,
            awaitingSince: freightOpportunities.awaitingApprovalSince,
            l1: freightOpportunities.slaNotifiedL1At,
            l2: freightOpportunities.slaNotifiedL2At,
          }).from(freightOpportunities).where(inArray(freightOpportunities.id, freightOppRows.map(r => r.id)));
          for (const s of slaRows) slaRowsById.set(s.id, { awaitingSince: s.awaitingSince, l1: s.l1, l2: s.l2 });
        } catch (slaErr) {
          noteFailure("availableFreight.sla", slaErr);
        }
      }

      // Task #365 — latest customer signal per company within last 7 days.
      // One LATERAL-style query keyed on companyId, joined into the payload
      // so the rep sees what the customer just said (pricing_request,
      // urgency_signal, etc.) when deciding whether to push hard now or wait.
      const latestSignalByCompany = new Map<string, {
        intentType: string;
        intentSubtype: string | null;
        signalAtIso: string;
        ageHours: number;
      }>();
      if (companyIds.length > 0) {
        try {
        // Hard-isolate by joining email_signals → email_messages and filtering
        // on the message's org_id. email_signals has no org_id of its own;
        // a signal's "owner" org is the org that ingested its parent message.
        // Without this guard a signal whose linked_account_id happens to match
        // a same-id row in another org could leak across tenants.
        const sigRows = await db.execute<{
          company_id: string;
          intent_type: string;
          intent_subtype: string | null;
          created_at: Date;
        }>(sql`
          SELECT DISTINCT ON (es.linked_account_id)
            es.linked_account_id AS company_id,
            es.intent_type,
            es.intent_subtype,
            es.created_at
          FROM email_signals es
          INNER JOIN email_messages em ON em.id = es.message_id
          WHERE es.linked_account_id = ANY(${companyIds}::text[])
            AND em.org_id = ${user.organizationId}
            AND es.created_at > NOW() - INTERVAL '7 days'
          ORDER BY es.linked_account_id, es.created_at DESC
        `);
        const rows = (sigRows as { rows?: unknown[] }).rows ?? [];
        for (const row of rows as Array<{ company_id: string; intent_type: string; intent_subtype: string | null; created_at: string | Date }>) {
          const at = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
          latestSignalByCompany.set(row.company_id, {
            intentType: row.intent_type,
            intentSubtype: row.intent_subtype,
            signalAtIso: at.toISOString(),
            ageHours: Number(((Date.now() - at.getTime()) / 3600000).toFixed(1)),
          });
        }
        } catch (sigErr) {
          noteFailure("availableFreight.signals", sigErr);
        }
      }

      const availableFreight = freightOppRows.map(r => {
        const sla = slaRowsById.get(r.id);
        const slaInfo = computeSlaState({
          approvedAt: r.approvedAt instanceof Date ? r.approvedAt : (r.approvedAt ? new Date(r.approvedAt) : null),
          status: r.status,
          awaitingApprovalSince: sla?.awaitingSince ?? null,
        });
        return {
          id: r.id,
          companyId: r.companyId,
          companyName: companyMap.get(r.companyId) ?? null,
          origin: r.origin,
          originState: r.originState,
          destination: r.destination,
          destinationState: r.destinationState,
          equipmentType: r.equipmentType,
          pickupWindowStart: r.pickupWindowStart,
          pickupWindowEnd: r.pickupWindowEnd,
          loadCount: r.loadCount,
          status: r.status,
          urgencyScore: r.urgencyScore,
          ownerUserId: r.ownerUserId,
          delegatedToUserId: r.delegatedToUserId,
          approvedAt: r.approvedAt instanceof Date ? r.approvedAt.toISOString() : (r.approvedAt as string | null),
          approvedById: r.approvedById,
          hasTemplateOverride: !!(r.templateOverrideSubject || r.templateOverrideBody),
          sourceFileName: r.sourceFileName,
          isDelegatedToMe: r.delegatedToUserId === user.id,
          needsApproval: !r.approvedAt && r.status === "ready_to_send",
          isUnassigned: !r.ownerUserId && !r.delegatedToUserId,
          // Task #364 — SLA fields surfaced for the badge + dashboard count.
          awaitingApprovalSince: slaInfo.awaitingSince,
          slaState: slaInfo.state,
          slaAgeHours: slaInfo.ageHours != null ? Number(slaInfo.ageHours.toFixed(2)) : null,
          // Task #365 — what the customer just told us (last 7 days). Null
          // when no signal exists; the UI hides the chip in that case.
          latestCustomerSignal: latestSignalByCompany.get(r.companyId) ?? null,
        };
      });

      // Manager-visible org-wide over-SLA count (drives the dashboard badge).
      // Only fired for managers viewing their own queue so reps stay minimal.
      let overSlaCount: number | null = null;
      if (isManagerSelfView) {
        try {
          overSlaCount = await countOverSlaForOrg(user.organizationId);
        } catch (slaErr) {
          noteFailure("overSlaCount", slaErr);
        }
      }

      return res.json({
        lwqLanes,
        awardTasks,
        availableFreight,
        triggeredPlays,
        viewing,
        pagination: {
          limit,
          lwqNextCursor,
          tasksNextCursor,
        },
        sla: {
          l1Hours: SLA_L1_HOURS,
          l2Hours: SLA_L2_HOURS,
          orgOverSlaCount: overSlaCount,
        },
        // Non-fatal sub-query failures so the UI can stay loaded even if a
        // single bucket choked. Empty array = everything succeeded.
        bucketErrors,
      });
    } catch (err) {
      console.error("[my-procurement]", err);
      return res.status(500).json({ error: "Failed to load procurement data" });
    }
  });

  /**
   * POST /api/my-procurement/lwq-lane/:laneId/resolve
   * Marks a recurring lane as resolved — removes it from My Procurement.
   * Sets resolved_at timestamp to NOW().
   * Also patches lane_summary_cache so the cache stays current.
   */
  app.post("/api/my-procurement/lwq-lane/:laneId/resolve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { laneId } = req.params;
      const resolvedAt = new Date().toISOString();
      await storage.pool.query(
        `UPDATE recurring_lanes
         SET resolved_at = NOW()::text, updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND org_id = $3`,
        [laneId, user.id, user.organizationId]
      );
      // Keep cache current — patch resolved_at so it disappears from list queries
      await storage.patchLaneSummaryCache(laneId, { resolvedAt }).catch(() => {});
      return res.json({ ok: true, laneId, resolvedAt });
    } catch (err) {
      console.error("[my-procurement/resolve]", err);
      return res.status(500).json({ error: "Failed to resolve lane" });
    }
  });

  // ── Available Freight tab actions (task #354) ─────────────────────────────

  /**
   * POST /api/my-procurement/freight-opp/:id/delegate
   * Owner (or manager) re-assigns the opportunity to another rep. Pass
   * `{ delegatedToUserId: null }` to clear the delegation.
   */
  const delegateSchema = z.object({
    delegatedToUserId: z.string().min(1).nullable(),
  });
  app.post("/api/my-procurement/freight-opp/:id/delegate", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      const isManager = APPROVER_ROLES.has(user.role);
      const isOwner = opp.ownerUserId === user.id;
      const isCurrentDelegate = opp.delegatedToUserId === user.id;
      if (!isManager && !isOwner && !isCurrentDelegate) {
        return res.status(403).json({ error: "Only the owner, current delegate, or a manager can delegate" });
      }

      const parsed = delegateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid delegate payload" });

      let target: { id: string; name: string | null } | null = null;
      if (parsed.data.delegatedToUserId) {
        const t = await storage.getUser(parsed.data.delegatedToUserId);
        if (!t || t.organizationId !== user.organizationId) {
          return res.status(404).json({ error: "Target user not found in this org" });
        }
        target = { id: t.id, name: t.name ?? t.email ?? null };
      }

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        delegatedToUserId: target?.id ?? null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "status_changed",
        actorUserId: user.id,
        payload: {
          kind: "delegation",
          from: opp.delegatedToUserId,
          to: target?.id ?? null,
          targetName: target?.name ?? null,
        },
      });
      if (updated && target?.id && target.id !== opp.delegatedToUserId) {
        await notifyFreightDelegated({
          storage,
          opportunity: updated,
          newDelegateUserId: target.id,
          actorUserId: user.id,
          actorName: user.name ?? null,
        });
      }
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/delegate]", err);
      return res.status(500).json({ error: "Failed to delegate opportunity" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/:id/assign
   * Manager-only. Routes an unassigned (or already owned) imported freight
   * row to a specific rep — used by the "Unassigned" filter in the My
   * Procurement Available Freight tab. Sets ownerUserId and clears any
   * existing delegate (the new owner can re-delegate themselves if they want).
   */
  const assignSchema = z.object({
    ownerUserId: z.string().min(1),
  });
  app.post("/api/my-procurement/freight-opp/:id/assign", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can assign freight opportunities" });
      }
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      // Gate: this endpoint is purpose-built for routing import-sourced
      // opportunities (the "Unassigned" bucket on the Available Freight tab).
      // Reassignment of carrier-procurement / manual opportunities flows
      // through other surfaces, so reject those here to keep the API surface
      // honest with the UI intent.
      const sourceKind = (opp.sourceRef as { kind?: string } | null)?.kind;
      if (sourceKind !== "available_freight_import") {
        return res.status(400).json({ error: "Only imported freight opportunities can be assigned via this endpoint" });
      }

      const parsed = assignSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid assign payload" });

      const target = await storage.getUser(parsed.data.ownerUserId);
      if (!target || target.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Target user not found in this org" });
      }

      // Task #364 — assigning an unassigned import is when the SLA clock
      // truly should "start ticking against a person." If the row had no
      // awaitingApprovalSince yet (e.g. legacy rows pre-#364), stamp it now.
      const slaStartPatch: Record<string, unknown> = opp.awaitingApprovalSince
        ? {}
        : { awaitingApprovalSince: new Date(), slaNotifiedL1At: null, slaNotifiedL2At: null };
      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        ownerUserId: target.id,
        delegatedToUserId: null,
        ...slaStartPatch,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "status_changed",
        actorUserId: user.id,
        payload: {
          kind: "assigned",
          from: opp.ownerUserId,
          to: target.id,
          targetName: target.name ?? target.email ?? null,
          previousDelegate: opp.delegatedToUserId,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/assign]", err);
      return res.status(500).json({ error: "Failed to assign opportunity" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/:id/approve
   * Manager-only. Stamps approvedAt + approvedById, unblocking the existing
   * /api/freight-opportunities/:id/send flow. Pass `{ approve: false }` to
   * revoke a prior approval (only allowed if no carriers have been sent).
   */
  const approveSchema = z.object({
    approve: z.boolean().default(true),
    note: z.string().max(2000).optional(),
  });
  app.post("/api/my-procurement/freight-opp/:id/approve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can approve freight opportunities" });
      }
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid approve payload" });
      const approving = parsed.data.approve;

      if (!approving) {
        const carriers = await storage.listFreightOpportunityCarriers(opp.id);
        if (carriers.some(c => c.sentAt)) {
          return res.status(400).json({ error: "Cannot revoke approval after a carrier has been sent" });
        }
      }

      // Task #364 — clear / restart the SLA clock alongside approval.
      const slaPatch: Record<string, unknown> = approving
        ? { awaitingApprovalSince: null, slaNotifiedL1At: null, slaNotifiedL2At: null }
        : { awaitingApprovalSince: new Date(), slaNotifiedL1At: null, slaNotifiedL2At: null };
      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        approvedAt: approving ? new Date() : null,
        approvedById: approving ? user.id : null,
        ...slaPatch,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "approved",
        actorUserId: user.id,
        payload: {
          approved: approving,
          note: parsed.data.note ?? null,
        },
      });
      if (approving && updated && !opp.approvedAt) {
        await notifyFreightApproved({
          storage,
          opportunity: updated,
          approverUserId: user.id,
          approverName: user.name ?? null,
        });
      }
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/approve]", err);
      return res.status(500).json({ error: "Failed to approve opportunity" });
    }
  });

  /**
   * PATCH /api/my-procurement/freight-opp/:id/template-override
   * Per-opportunity template subject/body that overrides the org default at
   * send time. Reps editing AFTER approval is allowed (the manager approved
   * the freight, not the copy) but each edit is audited.
   */
  const overrideSchema = z.object({
    subject: z.string().max(500).nullable().optional(),
    body: z.string().max(20_000).nullable().optional(),
  });
  app.patch("/api/my-procurement/freight-opp/:id/template-override", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const isManager = APPROVER_ROLES.has(user.role);
      const isOwner = opp.ownerUserId === user.id;
      const isDelegate = opp.delegatedToUserId === user.id;
      if (!isManager && !isOwner && !isDelegate) {
        return res.status(403).json({ error: "Only the owner, delegate, or a manager can edit the template" });
      }
      const parsed = overrideSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid template override" });

      const patch: Record<string, unknown> = {};
      if (parsed.data.subject !== undefined) patch.templateOverrideSubject = parsed.data.subject;
      if (parsed.data.body !== undefined) patch.templateOverrideBody = parsed.data.body;

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, patch);
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "template_edited",
        actorUserId: user.id,
        payload: {
          subjectChanged: parsed.data.subject !== undefined,
          bodyChanged: parsed.data.body !== undefined,
          subjectLen: (parsed.data.subject ?? "").length,
          bodyLen: (parsed.data.body ?? "").length,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/template-override]", err);
      return res.status(500).json({ error: "Failed to update template override" });
    }
  });

  /**
   * POST /api/available-freight/import
   * Triggers a fresh OneDrive pull. Available to admins, managers, AND any
   * rep who owns or is delegated at least one Available Freight opportunity
   * (lets reps refresh their own queue from the My Procurement tab).
   */
  app.post("/api/available-freight/import", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Any authenticated rep within the org can trigger a manual refresh —
      // the importer itself is org-scoped and idempotent, and recovery from a
      // failed scheduled run shouldn't require having a row already assigned.
      const summary = await performAvailableFreightImport(user.organizationId, user.id, "manual");
      return res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[available-freight/import]", msg);
      return res.status(400).json({ error: msg });
    }
  });

  /**
   * GET /api/available-freight/imports
   * Manager/admin only. Returns the most recent import-summary audit rows.
   */
  app.get("/api/available-freight/imports", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Manager access required" });
      }
      // Rolling 30-day window: pull a generous cap then trim to anything
      // newer than 30 days ago. Keeps the page focused on operationally
      // relevant runs without truncating a high-volume day.
      const cap = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "200"), 10) || 200));
      const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const all = await listAvailableFreightImports(user.organizationId, cap);
      const imports = all.filter((r) => {
        const t = Date.parse(r.createdAt);
        return Number.isFinite(t) ? t >= cutoffMs : true;
      });
      return res.json({ imports });
    } catch (err) {
      console.error("[available-freight/imports]", err);
      return res.status(500).json({ error: "Failed to list imports" });
    }
  });

  /**
   * POST /api/available-freight/manual
   * Task #365 — Rep-initiated freight opportunity. Used when a customer
   * sends a one-off load over the phone or email and the rep wants it
   * tracked in their procurement queue without waiting for the daily import.
   *
   * Behavior:
   *  - Caller defaults as the owner (managers may target another rep via `ownerUserId`).
   *  - sourceRef.kind = "manual" so the importer never tries to merge or expire it.
   *  - Approval gate is enforced exactly like imported rows: when the org's
   *    effective policy requires approval the row stays pending; otherwise
   *    it auto-approves to the caller (so a small org can send immediately).
   */
  const manualFreightOppSchema = z.object({
    companyId: z.string().min(1),
    mode: z.enum(["exact_load", "lane_building"]),
    origin: z.string().min(1),
    originState: z.string().nullable().optional(),
    destination: z.string().min(1),
    destinationState: z.string().nullable().optional(),
    equipmentType: z.string().nullable().optional(),
    pickupWindowStart: z.string().min(1),
    pickupWindowEnd: z.string().min(1),
    loadCount: z.number().int().positive().max(999).optional(),
    notes: z.string().max(2000).nullable().optional(),
    ownerUserId: z.string().min(1).optional(),
    // Task #365 — target rate (USD, all-in). Persisted on sourceRef so we
    // avoid a column migration; surfaced back via opp.sourceRef.targetRate.
    targetRate: z.number().positive().max(999999).nullable().optional(),
  });
  app.post("/api/available-freight/manual", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = manualFreightOppSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid manual freight payload",
          details: parsed.error.flatten(),
        });
      }
      const data = parsed.data;

      // Owner defaults to caller. Managers may target another rep via the
      // optional ownerUserId — non-managers may not.
      let ownerUserId: string = user.id;
      if (data.ownerUserId && data.ownerUserId !== user.id) {
        if (!APPROVER_ROLES.has(user.role)) {
          return res.status(403).json({ error: "Only managers can assign a manual freight opp to another rep" });
        }
        const target = await storage.getUser(data.ownerUserId);
        if (!target || target.organizationId !== user.organizationId) {
          return res.status(404).json({ error: "Target user not found in this org" });
        }
        ownerUserId = target.id;
      }

      // Verify company belongs to the org.
      const company = await storage.getCompany(data.companyId);
      if (!company || company.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Company not found" });
      }

      // Approval gate — manual opps respect the same policy as imported.
      const { loadEffectivePolicy } = await import("../proactiveOpportunityService");
      const policy = await loadEffectivePolicy(storage, user.organizationId, data.companyId);
      const requiresApproval = policy.approvalRequired;

      const now = new Date();
      const created = await storage.createFreightOpportunity({
        orgId: user.organizationId,
        companyId: data.companyId,
        mode: data.mode,
        recurringLaneId: null,
        geographicLanePatternId: null,
        origin: data.origin,
        originState: data.originState ?? null,
        destination: data.destination,
        destinationState: data.destinationState ?? null,
        equipmentType: data.equipmentType ?? null,
        pickupWindowStart: data.pickupWindowStart,
        pickupWindowEnd: data.pickupWindowEnd,
        loadCount: data.loadCount ?? 1,
        sourceRef: {
          kind: "manual",
          createdById: user.id,
          targetRate: data.targetRate ?? null,
        },
        urgencyScore: 60,
        confidenceFlag: "normal",
        status: "ready_to_send",
        ownerUserId,
        delegatedToUserId: null,
        senderMailbox: null,
        templateOverrideSubject: null,
        templateOverrideBody: null,
        cadenceConfig: null,
        approvedAt: requiresApproval ? null : now,
        approvedById: requiresApproval ? null : user.id,
        sourceFileName: null,
        awaitingApprovalSince: requiresApproval ? now : null,
        slaNotifiedL1At: null,
        slaNotifiedL2At: null,
        notes: data.notes ?? null,
        createdById: user.id,
        policySnapshot: null,
        expiresAt: null,
      } as InsertFreightOpportunity);

      await storage.appendFreightOpportunityAudit({
        opportunityId: created.id,
        eventType: "generated",
        actorUserId: user.id,
        payload: {
          source: "manual",
          companyId: data.companyId,
          requiresApproval,
          ownerUserId,
        },
      });

      return res.json({ ok: true, opportunity: created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[available-freight/manual]", msg);
      return res.status(500).json({ error: "Failed to create manual freight opportunity" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/bulk-approve
   * Manager-only. Approves multiple opportunities in one shot — used by the
   * "Awaiting my approval" queue in the My Procurement tab.
   */
  const bulkApproveSchema = z.object({
    opportunityIds: z.array(z.string().min(1)).min(1).max(200),
  });
  app.post("/api/my-procurement/freight-opp/bulk-approve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can approve freight opportunities" });
      }
      const parsed = bulkApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

      const now = new Date();
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of parsed.data.opportunityIds) {
        const opp = await storage.getFreightOpportunity(user.organizationId, id);
        if (!opp) { skipped.push({ id, reason: "not_found" }); continue; }
        if (opp.approvedAt) { skipped.push({ id, reason: "already_approved" }); continue; }
        if (opp.status !== "new" && opp.status !== "ready_to_send") {
          skipped.push({ id, reason: `not_open_status:${opp.status}` });
          continue;
        }
        const updatedOpp = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
          approvedAt: now,
          approvedById: user.id,
          // Task #364 — clear SLA clock on bulk approval too.
          awaitingApprovalSince: null,
          slaNotifiedL1At: null,
          slaNotifiedL2At: null,
        });
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: "approved",
          actorUserId: user.id,
          payload: { approved: true, kind: "bulk_approve" },
        });
        if (updatedOpp) {
          await notifyFreightApproved({
            storage,
            opportunity: updatedOpp,
            approverUserId: user.id,
            approverName: user.name ?? null,
          });
        }
        approved.push(opp.id);
      }
      return res.json({ approved, skipped });
    } catch (err) {
      console.error("[my-procurement/freight-opp/bulk-approve]", err);
      return res.status(500).json({ error: "Bulk approval failed" });
    }
  });

  /**
   * GET / PUT /api/available-freight/onedrive-url
   * Admin-only. Read or update the OneDrive path used by the importer.
   */
  app.get("/api/available-freight/onedrive-url", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const url = await storage.getSetting(availableFreightSettingKey(user.organizationId));
      const last = await storage.getSetting(`available_freight_last_import:${user.organizationId}`);
      let lastImport: unknown = null;
      if (last) { try { lastImport = JSON.parse(last); } catch { lastImport = last; } }
      return res.json({ url: url ?? null, lastImport });
    } catch (err) {
      console.error("[available-freight/onedrive-url GET]", err);
      return res.status(500).json({ error: "Failed to read setting" });
    }
  });
  /**
   * POST /api/available-freight/onedrive-url/test
   * Task #366 — Admin-only "Test connection" button. Verifies that the
   * configured share/Graph URL actually resolves to a downloadable workbook
   * without running the full importer (no row inserts, no audit pollution).
   * Surfaces the most common failure modes (no credentials, bad URL format,
   * Graph 401/403/404) so an admin can fix the setting before the next 5am
   * scheduled pull instead of waiting for the silent failure.
   */
  app.post("/api/available-freight/onedrive-url/test", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });

      // Allow either a body-supplied URL (admin testing a draft before save)
      // or fall back to the persisted setting (admin re-testing the live one).
      const bodyUrl = String((req.body ?? {}).url ?? "").trim();
      const filePath = bodyUrl || (await storage.getSetting(availableFreightSettingKey(user.organizationId))) || "";
      if (!filePath) {
        return res.status(400).json({ ok: false, status: 0, message: "No OneDrive URL configured or supplied" });
      }

      const { azureCredentialsConfigured, getGraphAccessToken } = await import("../graphService");
      if (!azureCredentialsConfigured()) {
        return res.status(400).json({
          ok: false,
          status: 0,
          message: "Azure credentials are not configured (OUTLOOK_TENANT_ID / OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET)",
        });
      }

      const trimmed = filePath.trim();
      let metaUrl: string;
      if (
        trimmed.startsWith("https://1drv.ms/") ||
        trimmed.startsWith("https://onedrive.live.com/") ||
        trimmed.includes("sharepoint.com/")
      ) {
        const encoded = "u!" + Buffer.from(trimmed).toString("base64").replace(/=/g, "").replace(/\//g, "_").replace(/\+/g, "-");
        metaUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem`;
      } else if (trimmed.startsWith("https://graph.microsoft.com/")) {
        metaUrl = trimmed.endsWith("/content") ? trimmed.slice(0, -"/content".length) : trimmed;
      } else if (trimmed.startsWith("/") || trimmed.startsWith("drives/") || trimmed.startsWith("users/") || trimmed.startsWith("me/")) {
        const rel = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
        const stripped = rel.endsWith("/content") ? rel.slice(0, -"/content".length) : rel;
        metaUrl = `https://graph.microsoft.com/v1.0/${stripped}`;
      } else {
        return res.status(400).json({
          ok: false,
          status: 400,
          message: "Unrecognized OneDrive path format. Use a OneDrive/SharePoint share link, full Graph URL, or a relative drives/{driveId}/items/{itemId} path.",
        });
      }

      let token: string;
      try {
        token = await getGraphAccessToken();
      } catch (err) {
        return res.status(400).json({
          ok: false,
          status: 0,
          message: `Failed to acquire Graph token: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Done-criteria says HEAD: cheap reachability probe with no body.
      // Graph supports HEAD on driveItem metadata endpoints — if it ever
      // returns 405 we fall back to GET so the test still surfaces a useful
      // signal instead of a misleading "broken" result.
      let resp = await fetch(metaUrl, { method: "HEAD", headers: { Authorization: `Bearer ${token}` } });
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetch(metaUrl, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      }
      if (!resp.ok) {
        return res.json({
          ok: false,
          status: resp.status,
          message: `Graph API returned HTTP ${resp.status}`,
        });
      }
      return res.json({
        ok: true,
        status: resp.status,
        message: "OneDrive source is reachable.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[available-freight/onedrive-url/test]", msg);
      return res.status(500).json({ ok: false, status: 0, message: msg });
    }
  });

  app.put("/api/available-freight/onedrive-url", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const url = String((req.body ?? {}).url ?? "").trim();
      if (!url) return res.status(400).json({ error: "url is required" });
      await storage.setSetting(availableFreightSettingKey(user.organizationId), url);
      return res.json({ ok: true, url });
    } catch (err) {
      console.error("[available-freight/onedrive-url PUT]", err);
      return res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.post("/api/my-procurement/award-task/:taskId/close", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { taskId } = req.params;
      await storage.pool.query(
        `UPDATE tasks
         SET status = 'closed', updated_at = NOW()::text
         WHERE id = $1 AND assigned_to = $2 AND org_id = $3`,
        [taskId, user.id, user.organizationId]
      );
      return res.json({ ok: true, taskId });
    } catch (err) {
      console.error("[my-procurement/award-task/close]", err);
      return res.status(500).json({ error: "Failed to close task" });
    }
  });
}
