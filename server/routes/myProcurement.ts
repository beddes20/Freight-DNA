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
import { storage } from "../storage";
import { getCurrentUser } from "../auth";
import { normalizeLaneLocation, normalizeEquipmentType } from "@shared/laneFormatters";

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
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Pagination params — default page size 50, max 200
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const lanesCursor = req.query.lanesCursor as string | undefined;
      const tasksCursor = req.query.tasksCursor as string | undefined;

      // ── 1. My lanes — prefer lane_summary_cache (lean, pre-computed), fall back to recurring_lanes ──
      // Cache path: no joins, no per-lane bench enrichment — just the pre-scored fields.
      const cacheRows = await storage.pool.query<{
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
      }>(
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
         WHERE lsc.owner_user_id = $1
           AND lsc.org_id = $2
           AND lsc.resolved_at IS NULL
         ORDER BY lsc.lane_score DESC NULLS LAST, lsc.lane_id`,
        [user.id, user.organizationId]
      );

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
           WHERE rl.owner_user_id = $1
             AND rl.org_id = $2
             AND rl.resolved_at IS NULL
           ORDER BY rl.lane_score DESC NULLS LAST`,
          [user.id, user.organizationId]
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
      const taskRows = await storage.pool.query<{
        id: string;
        title: string;
        status: string;
        due_date: string | null;
        company_id: string | null;
        created_at: string | null;
        attached_lane_data: unknown;
      }>(
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

      return res.json({
        lwqLanes,
        awardTasks,
        pagination: {
          limit,
          lwqNextCursor,
          tasksNextCursor,
        },
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

  /**
   * POST /api/my-procurement/award-task/:taskId/close
   * Closes an award procurement task — removes it from My Procurement.
   */
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
