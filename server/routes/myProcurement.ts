import type { Express } from "express";
import { storage, db } from "../storage";
import { getCurrentUser } from "../auth";
import { normalizeLaneLocation, normalizeEquipmentType } from "@shared/laneFormatters";
import { laneCarrierInterest } from "@shared/schema";
import { inArray } from "drizzle-orm";

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
   * Returns two buckets for the authenticated user:
   *   1. lwqLanes    — recurring_lanes where ownerUserId = me (LWQ assignments)
   *                    Excludes resolved lanes (resolved_at IS NOT NULL)
   *   2. awardTasks  — tasks where assignedTo = me AND type = "carrier_procurement"
   *                    Excludes closed tasks (status != 'open')
   *
   * Each award task includes `matchedLaneId` — the ID of the matching recurring_lane
   * found by normalized origin/destination + equipment-type lookup. Equipment type
   * must match (normalized) when stored on the task; falls back to O/D-only for
   * legacy tasks that predate equipment-type storage.
   */
  app.get("/api/my-procurement", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // ── 1. Recurring lanes assigned to me ──────────────────────────────────
      const laneRows = await storage.pool.query<{
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
        assigned_at: string | null;
        carriers_contacted_count: number | null;
        is_manual: boolean;
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
           rl.assigned_at,
           rl.carriers_contacted_count,
           rl.is_manual
         FROM recurring_lanes rl
         LEFT JOIN companies c ON c.id = rl.company_id
         WHERE rl.owner_user_id = $1
           AND rl.org_id = $2
           AND rl.resolved_at IS NULL
         ORDER BY rl.assigned_at DESC NULLS LAST`,
        [user.id, user.organizationId]
      );

      // ── 1b. Enrich each LWQ lane with a reply summary ─────────────────────
      const lwqLaneIds = laneRows.rows.map((r) => r.id);
      type BenchRow = { laneId: string; interestStatus: string; carrierName: string };
      let benchRows: BenchRow[] = [];
      if (lwqLaneIds.length > 0) {
        benchRows = (await db.select({
          laneId: laneCarrierInterest.laneId,
          interestStatus: laneCarrierInterest.interestStatus,
          carrierName: laneCarrierInterest.carrierName,
        }).from(laneCarrierInterest).where(inArray(laneCarrierInterest.laneId, lwqLaneIds))) as BenchRow[];
      }
      const benchByLane = new Map<string, BenchRow[]>();
      for (const b of benchRows) {
        if (!benchByLane.has(b.laneId)) benchByLane.set(b.laneId, []);
        benchByLane.get(b.laneId)!.push(b);
      }
      const HOT_STATUSES = new Set(["available_now", "available_next_week"]);
      const STATUS_PRIORITY: Record<string, number> = { available_now: 4, available_next_week: 3, future_interest: 2, not_fit: 1 };
      function computeReplySummary(bench: BenchRow[]) {
        const replied = bench.filter(b => b.interestStatus !== "needs_follow_up");
        let topEntry: BenchRow | null = null;
        let topPriority = -1;
        for (const b of replied) {
          const p = STATUS_PRIORITY[b.interestStatus] ?? 0;
          if (p > topPriority) { topPriority = p; topEntry = b; }
        }
        return {
          totalReplied: replied.length,
          hotCount: replied.filter(b => HOT_STATUSES.has(b.interestStatus)).length,
          topStatus: topEntry?.interestStatus ?? null,
          topCarrierName: topEntry?.carrierName ?? null,
        };
      }

      const lwqLanes = laneRows.rows.map((r) => ({
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
        assignedAt: r.assigned_at,
        carriersContactedCount: r.carriers_contacted_count ?? 0,
        isManual: r.is_manual,
        replySummary: computeReplySummary(benchByLane.get(r.id) ?? []),
      }));

      // ── 2. Award carrier-procurement tasks assigned to me ──────────────────
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

      // Parse award task lane metadata from attachedLaneData JSONB.
      // `equipmentType` is present on tasks created after the Phase 3 upgrade;
      // legacy tasks (no equipmentType) fall back to O/D-only matching.
      type RawAwardTask = {
        taskId: string;
        title: string;
        status: string;
        dueDate: string | null;
        companyId: string | null;
        createdAt: string | null;
        lane: string | null;
        origin: string | null;
        destination: string | null;
        volume: number | null;
        awardId: string | null;
        awardTitle: string | null;
        customerName: string | null;
        equipmentType: string | null;
        matchedLaneId: string | null;
      };

      const rawTasks: RawAwardTask[] = taskRows.rows.map((r) => {
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
          lane: (proc["lane"] as string) ?? null,
          origin: (proc["origin"] as string) ?? null,
          destination: (proc["destination"] as string) ?? null,
          volume: (proc["volume"] as number) ?? null,
          awardId: (proc["awardId"] as string) ?? null,
          awardTitle: (proc["awardTitle"] as string) ?? null,
          customerName: (proc["customerName"] as string) ?? null,
          equipmentType: (proc["equipmentType"] as string) ?? null,
          matchedLaneId: null,
        };
      });

      // ── 3. Lane ID lookup — match award tasks to recurring_lanes ─────────
      // Uses full normalization (case + whitespace + comma spacing) on both sides.
      // Fetches ALL rows per O/D pair so we can apply equipment-type filtering in JS.
      const tasksWithOD = rawTasks.filter((t) => t.origin && t.destination);

      if (tasksWithOD.length > 0) {
        // Collect unique normalized O/D pairs for the IN clause
        const pairMap = new Map<string, { normOrigin: string; normDest: string }>();
        for (const t of tasksWithOD) {
          const no = normalizeLaneLocation(t.origin!);
          const nd = normalizeLaneLocation(t.destination!);
          pairMap.set(`${no}|${nd}`, { normOrigin: no, normDest: nd });
        }
        const uniquePairs = [...pairMap.values()];

        // Single batch query — no DISTINCT ON so we get every row per O/D pair.
        // JS will select the right row based on equipment type.
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

        // Group lanes by (origin_key, dest_key) — preserves assigned_at DESC order
        const lanesByPair = new Map<string, Array<{ id: string; equipment_type: string | null }>>();
        for (const row of lookupResult.rows) {
          const key = `${row.origin_key}|${row.destination_key}`;
          if (!lanesByPair.has(key)) lanesByPair.set(key, []);
          lanesByPair.get(key)!.push({ id: row.id, equipment_type: row.equipment_type });
        }

        // For each task, find the best matching lane:
        //   - If task has equipmentType: require normalized equipment match.
        //     No matching equipment → matchedLaneId stays null ("No lane match").
        //   - Legacy tasks (no equipmentType stored): accept any lane for this O/D pair
        //     (backward-compatible; picks the most recently assigned).
        for (const task of rawTasks) {
          if (!task.origin || !task.destination) continue;
          const no = normalizeLaneLocation(task.origin);
          const nd = normalizeLaneLocation(task.destination);
          const candidates = lanesByPair.get(`${no}|${nd}`) ?? [];
          if (candidates.length === 0) continue;

          if (task.equipmentType) {
            // Equipment-aware matching: both sides normalized through normalizeEquipmentType
            const targetEquip = normalizeEquipmentType(task.equipmentType);
            const match = candidates.find(
              (c) => normalizeEquipmentType(c.equipment_type) === targetEquip
            );
            task.matchedLaneId = match?.id ?? null;
          } else {
            // Legacy task: O/D-only, pick most recently assigned (first in sorted list)
            task.matchedLaneId = candidates[0].id;
          }
        }
      }

      // ── 4. Enrich award tasks with reply summaries for matched lanes ──────
      const awardMatchedLaneIds = rawTasks.map((t) => t.matchedLaneId).filter((id): id is string => !!id);
      const awardBenchRows: { laneId: string; interestStatus: string; carrierName: string }[] =
        awardMatchedLaneIds.length > 0
          ? ((await db.select({
              laneId: laneCarrierInterest.laneId,
              interestStatus: laneCarrierInterest.interestStatus,
              carrierName: laneCarrierInterest.carrierName,
            }).from(laneCarrierInterest).where(inArray(laneCarrierInterest.laneId, awardMatchedLaneIds))) as {
              laneId: string;
              interestStatus: string;
              carrierName: string;
            }[])
          : [];
      const awardBenchByLane = new Map<string, { laneId: string; interestStatus: string; carrierName: string }[]>();
      for (const b of awardBenchRows) {
        if (!awardBenchByLane.has(b.laneId)) awardBenchByLane.set(b.laneId, []);
        awardBenchByLane.get(b.laneId)!.push(b);
      }
      const awardTasks = rawTasks.map((t) => ({
        ...t,
        replySummary: t.matchedLaneId ? computeReplySummary(awardBenchByLane.get(t.matchedLaneId) ?? []) : null,
      }));

      return res.json({ lwqLanes, awardTasks });
    } catch (err) {
      console.error("[my-procurement]", err);
      return res.status(500).json({ error: "Failed to load procurement data" });
    }
  });

  /**
   * POST /api/my-procurement/lwq-lane/:laneId/resolve
   * Marks a recurring lane as resolved — removes it from My Procurement.
   * Sets resolved_at timestamp to NOW().
   */
  app.post("/api/my-procurement/lwq-lane/:laneId/resolve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { laneId } = req.params;
      await storage.pool.query(
        `UPDATE recurring_lanes
         SET resolved_at = NOW()::text, updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND org_id = $3`,
        [laneId, user.id, user.organizationId]
      );
      return res.json({ ok: true });
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
      return res.json({ ok: true });
    } catch (err) {
      console.error("[my-procurement/award-task/close]", err);
      return res.status(500).json({ error: "Failed to close task" });
    }
  });
}
